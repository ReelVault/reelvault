import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallCatalogPluginResponse, PluginValidationResult } from "@reelvault/sdk/common";
import { pluginRepositoriesRepository } from "@/database/repositories/plugin-repositories.repository";
import { env } from "@/env";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { assertChecksumMatches } from "@/utils/crypto.utils";
import { DomainError, errorCodeOf, toErrorCode } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { decryptSecret, encryptSecret } from "@/utils/secret-crypto.utils";
import { isNewerVersion } from "@/utils/semver.utils";
import { guardedFetch } from "@/utils/url-guard.utils";
import { SERVER_VERSION } from "@/version";
import {
	isHttpsUrl,
	OFFICIAL_PLUGIN_REPOSITORY,
	PLUGIN_CATALOG_MAX_MANIFEST_BYTES,
	type PluginCatalogCategory,
	type PluginCatalogManifest,
	type PluginCatalogVersionEntry,
	parsePluginCatalogManifest,
	resolveCatalogCandidate,
} from "./catalog-manifest";
import { downloadArchive, extractPluginPackage } from "./plugin-package.utils";
import { archiveValidationFailure, validatePluginPackage } from "./plugin-package-validation";

const CACHE_TTL_MS = 15 * 60_000;
const MANIFEST_TIMEOUT_MS = 20_000;
/** The lockfile provenance format for catalog installs (vs. absolute paths for manual installs). */
const catalogSource = (repositoryId: string, pluginId: string, version: string): string => `catalog:${repositoryId}:${pluginId}@${version}`;

const toVersionView = (entry: PluginCatalogVersionEntry): PluginCatalogVersionView => ({
	version: entry.version,
	...(entry.date ? { date: entry.date } : {}),
	...(entry.changelog ? { changelog: entry.changelog } : {}),
	...(entry.minServerVersion ? { minServerVersion: entry.minServerVersion } : {}),
});

export interface PluginRepositoryView {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
	hasToken: boolean;
	lastRefreshedAt: string | null;
	lastErrorCode: string | null;
	createdAt: string;
	updatedAt: string;
}

export type PluginCatalogInstallStatus = "available" | "installed" | "update-available";

/** A previously published version as visible to admins — download details stay server-side. */
export interface PluginCatalogVersionView {
	version: string;
	date?: string;
	changelog?: string;
	minServerVersion?: string;
}

/** Code for a repository whose manifest could not be read; the message stays in the server log. */
const PLUGIN_REPOSITORY_UNAVAILABLE = "plugin.repository_unavailable";

/** A catalog repository that could not be read, so its plugins are missing from the catalog. */
export interface PluginCatalogUnavailableRepository {
	repositoryId: string;
	repositoryName: string;
	errorCode: string;
}

/** The aggregated catalog plus the repositories that did not contribute to it. */
export interface PluginCatalogView {
	plugins: PluginCatalogEntryView[];
	unavailableRepositories: PluginCatalogUnavailableRepository[];
}

export interface PluginCatalogEntryView {
	id: string;
	name: string;
	version: string;
	description?: string;
	category: PluginCatalogCategory;
	homepage?: string;
	iconUrl?: string;
	changelog?: string;
	capabilities?: string[];
	date?: string;
	/** Oldest server release that can install this version — the install endpoint refuses older servers. */
	minServerVersion?: string;
	versions?: PluginCatalogVersionView[];
	repositoryId: string;
	repositoryName: string;
	status: PluginCatalogInstallStatus;
	installedVersion: string | null;
}

export interface InstallCatalogPluginInput {
	repositoryId: string;
	pluginId: string;
	version?: string;
}

type RepositoryRow = Awaited<ReturnType<typeof pluginRepositoriesRepository.list>>[number];

interface CachedManifest {
	manifest: PluginCatalogManifest;
	fetchedAt: number;
}

class PluginCatalogService {
	private readonly logger = createLogger("PluginCatalogService");
	private readonly cache = new Map<string, CachedManifest>();

	async listRepositories(): Promise<PluginRepositoryView[]> {
		await this.ensureOfficialRepository();
		const rows = await pluginRepositoriesRepository.list();

		return rows.map((row) => this.toView(row));
	}

	async createRepository(values: { name: string; url: string; token?: string | null }): Promise<PluginRepositoryView> {
		if (!isHttpsUrl(values.url))
			throw new DomainError("validation", "Repository URL must be an https URL", { code: "plugin.repository_url_invalid" });

		const row = await pluginRepositoriesRepository.create({
			name: values.name,
			url: values.url,
			tokenEncrypted: values.token ? encryptSecret(values.token, env.BETTER_AUTH_SECRET) : null,
		});
		await this.refreshRepository(row.id).catch((error) => {
			// Creation succeeds even if the first fetch fails — the error is
			// recorded on the row so the UI can surface it.
			this.logger.warn("Initial catalog refresh failed", {
				reason: error instanceof Error ? error.message : String(error),
			});
		});
		const created = await pluginRepositoriesRepository.findById(row.id);
		if (!created) throw new DomainError("not_found", `Plugin repository not found: ${row.id}`, { code: "plugin.repository_not_found" });

		return this.toView(created);
	}

	async updateRepository(
		id: string,
		values: { name?: string; url?: string; token?: string | null; enabled?: boolean },
	): Promise<PluginRepositoryView> {
		const existing = await pluginRepositoriesRepository.findById(id);
		if (!existing) throw new DomainError("not_found", `Plugin repository not found: ${id}`, { code: "plugin.repository_not_found" });

		if (values.url !== undefined && !isHttpsUrl(values.url))
			throw new DomainError("validation", "Repository URL must be an https URL", { code: "plugin.repository_url_invalid" });

		// undefined = leave the stored token unchanged, null = remove it, string = replace it
		let tokenEncrypted: string | null | undefined;
		if (values.token === null) {
			tokenEncrypted = null;
		} else if (values.token !== undefined) {
			tokenEncrypted = encryptSecret(values.token, env.BETTER_AUTH_SECRET);
		}

		const updated = await pluginRepositoriesRepository.update(id, {
			...(values.name !== undefined ? { name: values.name } : {}),
			...(values.url !== undefined ? { url: values.url } : {}),
			...(tokenEncrypted !== undefined ? { tokenEncrypted } : {}),
			...(values.enabled !== undefined ? { enabled: values.enabled } : {}),
		});

		// A URL/token change invalidates the cached manifest.
		if (values.url !== undefined || values.token !== undefined) this.cache.delete(id);

		return this.toView(updated);
	}

	async deleteRepository(id: string): Promise<void> {
		const existing = await pluginRepositoriesRepository.findById(id);
		if (!existing) throw new DomainError("not_found", `Plugin repository not found: ${id}`, { code: "plugin.repository_not_found" });

		await pluginRepositoriesRepository.delete(id);
		this.cache.delete(id);
	}

	async refreshRepository(id: string): Promise<PluginRepositoryView> {
		const existing = await pluginRepositoriesRepository.findById(id);
		if (!existing) throw new DomainError("not_found", `Plugin repository not found: ${id}`, { code: "plugin.repository_not_found" });

		await this.fetchManifest(existing, { force: true });
		const refreshed = await pluginRepositoriesRepository.findById(id);
		if (!refreshed) throw new DomainError("not_found", `Plugin repository not found: ${id}`, { code: "plugin.repository_not_found" });

		return this.toView(refreshed);
	}

	/** Installed plugins that an enabled repository offers in a newer version. A failing catalog offers none. */
	async updatablePluginIds(): Promise<Set<string>> {
		try {
			const { plugins } = await this.getCatalog();

			return new Set(plugins.filter((entry) => entry.status === "update-available").map((entry) => entry.id));
		} catch (error) {
			this.logger.warn("Plugin update check skipped", { reason: error instanceof Error ? error.message : String(error) });

			return new Set();
		}
	}

	/** Aggregated catalog across all enabled repositories, annotated with install state. */
	async getCatalog(): Promise<PluginCatalogView> {
		await this.ensureOfficialRepository();
		const rows = (await pluginRepositoriesRepository.list()).filter((row) => row.enabled);
		const records = await pluginManager.getInstalledRecords();
		const installed = new Map(records.map((record) => [record.id, record.record.version]));
		// A pinned plugin keeps its installed version: the catalog reports it as installed, never as updatable.
		const pinned = new Set(records.filter((record) => record.record.pinned === true).map((record) => record.id));

		// One unavailable repository must not sink the catalog, and the cold load
		// must not serialize network round-trips — fetch concurrently, flatten in
		// repository order.
		const perRepository = await Promise.all(
			rows.map(async (row) => {
				try {
					const { manifest } = await this.fetchManifest(row, { force: false });

					const plugins = manifest.plugins.map((plugin): PluginCatalogEntryView => {
						const installedVersion = installed.get(plugin.id) ?? null;

						return {
							...plugin,
							...(plugin.versions ? { versions: plugin.versions.map(toVersionView) } : {}),
							repositoryId: row.id,
							repositoryName: row.name,
							status: pinned.has(plugin.id) && installedVersion ? "installed" : this.installStatus(plugin.version, installedVersion),
							installedVersion,
						};
					});

					return { plugins };
				} catch (error) {
					this.logger.warn("Skipping unavailable plugin repository", {
						reason: error instanceof Error ? error.message : String(error),
						repositoryId: row.id,
					});

					return {
						plugins: [] as PluginCatalogEntryView[],
						unavailable: {
							repositoryId: row.id,
							repositoryName: row.name,
							errorCode: error instanceof DomainError ? error.code : PLUGIN_REPOSITORY_UNAVAILABLE,
						},
					};
				}
			}),
		);

		return {
			plugins: perRepository.flatMap((outcome) => outcome.plugins),
			unavailableRepositories: perRepository.flatMap((outcome) => (outcome.unavailable ? [outcome.unavailable] : [])),
		};
	}

	async installFromCatalog(input: InstallCatalogPluginInput): Promise<InstallCatalogPluginResponse> {
		const row = await pluginRepositoriesRepository.findById(input.repositoryId);
		if (!row)
			throw new DomainError("not_found", `Plugin repository not found: ${input.repositoryId}`, { code: "plugin.repository_not_found" });

		const { manifest } = await this.fetchManifest(row, { force: false });

		const candidate = resolveCatalogCandidate(manifest.plugins, input.pluginId, input.version);
		if (!candidate)
			throw new DomainError(
				"not_found",
				`Plugin ${input.pluginId} (version ${input.version ?? "latest"}) not found in repository ${row.name}`,
				{
					code: "plugin.not_in_repository",
					params: { plugin: input.pluginId },
				},
			);

		// The catalog entry declares the oldest compatible server — refuse before
		// downloading anything. Mirrors the web-UI update gate.
		if (candidate.minServerVersion && isNewerVersion(candidate.minServerVersion, SERVER_VERSION)) {
			throw new DomainError(
				"validation",
				`Plugin ${candidate.id} ${candidate.version} requires server ${candidate.minServerVersion} or newer (running ${SERVER_VERSION}) — update the server first`,
				{ code: "plugin.server_too_old" },
			);
		}

		const token = this.tokenFor(row);
		const download = await downloadArchive(candidate.downloadUrl, token ? { token } : {});
		let extracted: Awaited<ReturnType<typeof extractPluginPackage>> | undefined;
		try {
			assertChecksumMatches(download.checksum, candidate.checksum, {
				checksum: false,
				code: "plugin.checksum_mismatch",
				message: "Plugin package checksum does not match the catalog manifest",
			});
			extracted = await extractPluginPackage(download.filePath);
			const result = await pluginManager.installFromDirectory(extracted.pluginRoot, {
				source: catalogSource(row.id, candidate.id, candidate.version),
			});
			this.logger.info(`Installed plugin ${candidate.id}@${candidate.version} from repository ${row.name} (${result.state})`);

			return result;
		} finally {
			await extracted?.cleanup();
			await download.cleanup();
		}
	}

	async installFromArchive(archive: Blob, options: { source?: string } = {}): Promise<InstallCatalogPluginResponse> {
		const temporaryPath = join(tmpdir(), `reelvault-plugin-upload-${crypto.randomUUID()}.bin`);
		let extracted: Awaited<ReturnType<typeof extractPluginPackage>> | undefined;
		try {
			await Bun.write(temporaryPath, archive);
			extracted = await extractPluginPackage(temporaryPath);
			const result = await pluginManager.installFromDirectory(extracted.pluginRoot, { source: options.source ?? "upload" });
			this.logger.info(`Installed plugin ${result.pluginId}@${result.version} from uploaded archive (${result.state})`);

			return result;
		} finally {
			await extracted?.cleanup();
			await rm(temporaryPath, { force: true });
		}
	}

	/** Dry run of an uploaded archive: reports what installing it would do and installs nothing. */
	async validateArchive(archive: Blob): Promise<PluginValidationResult> {
		const temporaryPath = join(tmpdir(), `reelvault-plugin-validate-${crypto.randomUUID()}.bin`);
		let extracted: Awaited<ReturnType<typeof extractPluginPackage>> | undefined;
		try {
			await Bun.write(temporaryPath, archive);
			try {
				extracted = await extractPluginPackage(temporaryPath);
			} catch (error) {
				return archiveValidationFailure(error);
			}

			const installed = (await pluginManager.getInstalledRecords()).map(({ id, record }) => ({ id, version: record.version }));

			return await validatePluginPackage(extracted.pluginRoot, installed);
		} finally {
			await extracted?.cleanup();
			await rm(temporaryPath, { force: true });
		}
	}

	async uninstallPlugin(pluginId: string): Promise<void> {
		const installed = (await pluginManager.getInstalledRecords()).some((record) => record.id === pluginId);
		if (!installed)
			throw new DomainError("not_found", `Plugin is not installed: ${pluginId}`, {
				code: "plugin.not_installed",
				params: { plugin: pluginId },
			});

		await pluginManager.uninstall(pluginId);
		this.logger.info(`Uninstalled plugin ${pluginId}`);
	}

	/** Seeds the official repository so a fresh server's catalog is never empty. */
	private async ensureOfficialRepository(): Promise<void> {
		if ((await pluginRepositoriesRepository.count()) > 0) return;

		await pluginRepositoriesRepository.createIfAbsent({
			name: OFFICIAL_PLUGIN_REPOSITORY.name,
			url: OFFICIAL_PLUGIN_REPOSITORY.url,
		});
		this.logger.info(`Seeded plugin repository ${OFFICIAL_PLUGIN_REPOSITORY.name}`);
	}

	private installStatus(catalogVersion: string, installedVersion: string | null): PluginCatalogInstallStatus {
		if (!installedVersion) return "available";

		if (installedVersion === catalogVersion) return "installed";

		try {
			return Bun.semver.order(catalogVersion, installedVersion) > 0 ? "update-available" : "installed";
		} catch {
			return "installed";
		}
	}

	private async fetchManifest(row: RepositoryRow, options: { force: boolean }): Promise<CachedManifest> {
		const cached = this.cache.get(row.id);
		if (!options.force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

		try {
			const token = this.tokenFor(row);
			// Repository URLs are admin-configured, but a compromised/redirecting
			// host must still not be able to reach loopback/RFC1918 (SSRF) or leak
			// the bearer token; the body is read with a hard byte cap while streaming.
			const response = await guardedFetch(row.url, {
				...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
				signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
			});
			if (!response.ok)
				throw new DomainError("validation", `Repository manifest fetch failed with HTTP ${response.status}`, {
					code: "plugin.repository_fetch_failed",
					params: { status: response.status },
				});

			const body = await readBodyTextWithinLimit(response, PLUGIN_CATALOG_MAX_MANIFEST_BYTES);
			const manifest = parsePluginCatalogManifest(body);

			const cachedManifest = { manifest, fetchedAt: Date.now() };
			this.cache.set(row.id, cachedManifest);
			await pluginRepositoriesRepository.update(row.id, { lastRefreshedAt: new Date(), lastError: null });

			return cachedManifest;
		} catch (error) {
			await pluginRepositoriesRepository.update(row.id, { lastError: errorCodeOf(error, PLUGIN_REPOSITORY_UNAVAILABLE) });
			// A previously-good cache keeps the catalog usable while the upstream is down.
			if (cached) return cached;

			throw error;
		}
	}

	private tokenFor(row: Pick<RepositoryRow, "tokenEncrypted">): string | undefined {
		if (!row.tokenEncrypted) return undefined;

		return decryptSecret(row.tokenEncrypted, env.BETTER_AUTH_SECRET);
	}

	private toView(row: RepositoryRow): PluginRepositoryView {
		return {
			id: row.id,
			name: row.name,
			url: row.url,
			enabled: row.enabled,
			hasToken: row.tokenEncrypted !== null && row.tokenEncrypted.length > 0,
			lastRefreshedAt: row.lastRefreshedAt ? row.lastRefreshedAt.toISOString() : null,
			lastErrorCode: toErrorCode(row.lastError, PLUGIN_REPOSITORY_UNAVAILABLE),
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}
}

export const pluginCatalogService = new PluginCatalogService();

/**
 * Reads a response body as text while enforcing a byte cap during the stream —
 * a hostile repository must not be able to buffer an unbounded payload.
 */
async function readBodyTextWithinLimit(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > maxBytes)
		throw new DomainError("validation", "Repository manifest exceeds the size limit", { code: "plugin.repository_too_large" });

	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new DomainError("validation", "Repository manifest exceeds the size limit", { code: "plugin.repository_too_large" });
			}

			text += decoder.decode(value, { stream: true });
		}

		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}

	return text;
}
