import type { PluginConfigDetails } from "@reelvault/sdk/common";
import type {
	MetadataProvider,
	PluginConfigField,
	PluginRuntime,
	PluginStatus,
	ProviderStatus,
	SubtitleProvider,
	SubtitleProviderStatus,
} from "@reelvault/sdk/plugin";
import { serverConfig } from "@/server.config";
import { errorMessage, ValidationError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { Mutex } from "@/utils/mutex";
import { pickDefined } from "@/utils/type.utils";
import { PluginConfig } from "../plugin.config";
import { type InstalledPlugin, type InstalledPluginRecord, PluginInstaller } from "../plugin.installer";
import { PluginLoader } from "../plugin.loader";
import { loadPluginManifest } from "../plugin.manifest";
import { type PluginRegistry, pluginRegistry } from "../plugin.registry";

const CAPITALIZE_FIRST_REGEX = /^./;
const CAMEL_CASE_SPLIT_REGEX = /([A-Z])/g;
const SECRET_KEYWORDS = ["key", "secret", "token", "password"];

function byStatusName(a: PluginStatus, b: PluginStatus): number {
	return a.name.localeCompare(b.name);
}

function disabledStatus(id: string, name: string, version: string, description?: string): PluginStatus {
	return {
		id,
		name,
		version,
		state: "disabled",
		providers: 0,
		subtitleProviders: 0,
		jobs: 0,
		...pickDefined({ description }),
	};
}

export class PluginManager {
	private readonly logger = createLogger("PluginManager");
	private readonly config: PluginConfig;
	private readonly registry: PluginRegistry;
	private readonly loader: PluginLoader;
	private readonly installer: PluginInstaller;
	/** Serialises lifecycle mutations (install/reload/enable/uninstall) across admin requests. */
	private readonly lifecycleMutex = new Mutex();
	/** Installed but unloaded plugins — the registry only tracks loaded ones, so the disabled state lives here. */
	private readonly disabledStatuses = new Map<string, PluginStatus>();

	constructor() {
		this.config = new PluginConfig();
		this.registry = pluginRegistry;
		this.loader = new PluginLoader(this.config, this.registry);
		this.installer = new PluginInstaller(serverConfig.paths.plugins);
	}

	async loadPlugins(): Promise<void> {
		await this.verifyInstalledPlugins();
		await this.seedDisabledStatuses();
		await this.loader.loadAll();
	}

	/**
	 * Advisory integrity check against `plugins.lock.json` (only installer-managed
	 * plugins have lockfile entries). Never blocks boot: a package edited
	 * out-of-band (a plugin directory refreshed by hand) or a lockfile written
	 * under an older hash scheme is reconciled by rewriting the stale record, so
	 * the mismatch is reported once instead of spamming every startup.
	 */
	private async verifyInstalledPlugins(): Promise<void> {
		try {
			const refreshed = await this.installer.refreshIntegrity();
			if (refreshed.length > 0) {
				this.logger.warn("Plugin integrity changed — lockfile records refreshed", { plugins: refreshed });
			}
		} catch (error) {
			this.logger.error("Plugin integrity verification failed", error);
		}
	}

	/** The loader skips lockfile-disabled plugins entirely — without this seed they would be invisible to the admin API. */
	private async seedDisabledStatuses(): Promise<void> {
		this.disabledStatuses.clear();
		let installed: InstalledPlugin[] = [];
		try {
			installed = await this.installer.list();
		} catch (error) {
			this.logger.warn("Disabled plugin seeding skipped — lockfile unreadable", { error: errorMessage(error) });

			return;
		}

		for (const { id, record } of installed) {
			if (record.disabled !== true) continue;

			this.disabledStatuses.set(id, await this.disabledStatusFromRecord(id, record));
		}
	}

	private async disabledStatusFromRecord(pluginId: string, record: InstalledPluginRecord): Promise<PluginStatus> {
		try {
			const manifest = await loadPluginManifest(this.config.resolvePluginDirectory(record.directory));
			if (manifest.id === pluginId) return disabledStatus(manifest.id, manifest.name, manifest.version, manifest.description);
		} catch {
			// A missing or broken manifest falls back to the lockfile identity below.
		}

		return disabledStatus(pluginId, pluginId, record.version);
	}

	/**
	 * Persists the enabled/disabled state and (un)loads under one lock, so two
	 * concurrent enable/disable requests cannot interleave with each other or
	 * with an install/reload.
	 */
	async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
		await this.lifecycleMutex.runExclusive(async () => {
			try {
				await this.installer.setDisabled(pluginId, !enabled);
			} catch {
				// Non-installer plugins have no lockfile entry — unload/load only.
			}

			if (enabled) {
				const dirName = (await this.loader.findDirectoryNameForPluginId(pluginId)) ?? pluginId;
				try {
					await this.loader.load(dirName);
				} finally {
					// A failed load leaves the plugin in the failed registry bucket — it must not linger as disabled.
					this.disabledStatuses.delete(pluginId);
				}
			} else {
				// Unloading removes the plugin from the registry, so its status must be captured first —
				// this map is then the only place that still knows the plugin exists.
				const status =
					this.statusFromRegistry(pluginId) ?? this.disabledStatuses.get(pluginId) ?? (await this.statusFromManifest(pluginId));
				if (!status) throw new ValidationError(`Plugin ${pluginId} is not installed`);

				try {
					// unloadPlugin unregisters even when lifecycle hooks fail (it throws afterwards),
					// so the disabled status must be recorded either way.
					await this.loader.unloadPlugin(pluginId);
				} finally {
					this.disabledStatuses.set(pluginId, status);
				}
			}
		});
	}

	private statusFromRegistry(pluginId: string): PluginStatus | undefined {
		const runtime = this.registry.get(pluginId);

		return runtime
			? disabledStatus(runtime.manifest.id, runtime.manifest.name, runtime.manifest.version, runtime.manifest.description)
			: undefined;
	}

	private async statusFromManifest(pluginId: string): Promise<PluginStatus | undefined> {
		const dirName = (await this.loader.findDirectoryNameForPluginId(pluginId)) ?? pluginId;
		try {
			const manifest = await loadPluginManifest(this.config.resolvePluginDirectory(dirName));
			if (manifest.id !== pluginId) return undefined;

			return disabledStatus(manifest.id, manifest.name, manifest.version, manifest.description);
		} catch {
			return undefined;
		}
	}

	/** Full reload: unload every plugin first, then load them again. */
	async reloadAll(): Promise<void> {
		await this.lifecycleMutex.runExclusive(async () => {
			await this.loader.unloadAll();
			await this.loader.loadAll();
		});
	}

	/** Resolves a plugin id to its on-disk directory name (used for serving plugin statics). */
	async getPluginDirectoryName(pluginId: string): Promise<string | undefined> {
		return await this.loader.findDirectoryNameForPluginId(pluginId);
	}

	async load(pluginName: string): Promise<void> {
		await this.lifecycleMutex.runExclusive(() => this.loader.load(pluginName));
	}

	async reload(pluginId: string): Promise<void> {
		await this.lifecycleMutex.runExclusive(async () => {
			// load() ignores the lockfile flag — reloading a disabled plugin would silently enable it until restart.
			if (this.disabledStatuses.has(pluginId)) return;

			await this.loader.reloadPlugin(pluginId);
		});
	}

	async unload(pluginId: string): Promise<void> {
		await this.lifecycleMutex.runExclusive(() => this.loader.unloadPlugin(pluginId));
	}

	async uninstall(pluginId: string): Promise<void> {
		await this.lifecycleMutex.runExclusive(async () => {
			await this.loader.uninstallPlugin(pluginId);
			try {
				// Removes the directory and the lockfile entry. Manually dropped
				// plugins have no lockfile record — their data is already gone at
				// this point, so a missing record only needs to be tolerated.
				await this.installer.uninstall(pluginId);
			} catch (error) {
				if (!(error instanceof ValidationError)) throw error;

				this.logger.warn(`No installer record for ${pluginId} — removed loaded data only`);
			}

			// Cleared only after the installer succeeded — a failed uninstall leaves the plugin installed.
			this.disabledStatuses.delete(pluginId);
		});
	}

	/** Installs (or upgrades) a plugin package from an unpacked directory on disk. */
	async installFromDirectory(sourceDirectory: string, options: { source?: string }) {
		return await this.lifecycleMutex.runExclusive(async () => {
			const result = await this.installer.install(sourceDirectory, {
				upgrade: true,
				...(options.source !== undefined ? { source: options.source } : {}),
			});
			// The fresh record carries no disabled flag — a reinstalled plugin is enabled-by-default again.
			this.disabledStatuses.delete(result.id);

			// A plugin that is already loaded still runs the OLD build from memory and
			// its on-disk directory was just swapped. Reload so the new code takes
			// effect immediately; a fresh install stays unloaded until enabled.
			// Calls the loader directly — `this.reload` would re-enter the same lock.
			if (this.registry.get(result.id)) {
				try {
					await this.loader.reloadPlugin(result.id);
				} catch (error) {
					this.logger.error(`Plugin ${result.id} installed but failed to reload`, error);
				}
			}

			return result;
		});
	}

	/** Installer-managed plugins, including disabled and currently-unloaded ones. */
	async getInstalledRecords(): Promise<Array<{ id: string; record: InstalledPluginRecord }>> {
		return await this.installer.list();
	}

	async shutdown(): Promise<void> {
		await this.loader.unloadAll();
	}

	getPlugin(id: string): PluginRuntime | undefined {
		return this.registry.get(id);
	}

	getStatus(): PluginStatus[] {
		// Working plugins first, then disabled, failed ones trailing — alphabetical within each group.
		const loaded = [...this.registry.getStatuses()].toSorted(byStatusName);
		const loadedIds = new Set(loaded.map((status) => status.id));
		const disabled = [...this.disabledStatuses.values()].filter((status) => !loadedIds.has(status.id)).toSorted(byStatusName);
		const failed = [...this.registry.getFailedStatuses()].toSorted(byStatusName);

		return [...loaded, ...disabled, ...failed];
	}

	getProviders(): MetadataProvider[] {
		return this.registry.getProviders();
	}

	getProviderStatus(): ProviderStatus[] {
		return this.registry.getProviderStatus();
	}

	getProvider(providerId: string): MetadataProvider | undefined {
		return this.registry.getProvider(providerId);
	}

	getSubtitleProviders(): SubtitleProvider[] {
		return this.registry.getSubtitleProviders();
	}

	getSubtitleProviderStatus(): SubtitleProviderStatus[] {
		return this.registry.getSubtitleProviderStatus();
	}

	getSubtitleProvider(providerId: string): SubtitleProvider | undefined {
		return this.registry.getSubtitleProvider(providerId);
	}

	getConfig(pluginName: string) {
		return this.config.get(pluginName);
	}

	private async resolvePluginDirectoryName(pluginId: string): Promise<string> {
		// Delegate to the loader's id→directory index (a plugin id is NOT its
		// directory name) instead of re-reading every manifest here.
		return (await this.loader.findDirectoryNameForPluginId(pluginId)) ?? pluginId;
	}

	async getPluginConfigDetails(pluginId: string): Promise<PluginConfigDetails> {
		const dirName = await this.resolvePluginDirectoryName(pluginId);
		const pluginDir = this.config.resolvePluginDirectory(dirName);
		const manifest = await loadPluginManifest(pluginDir);
		const config = await this.config.load(pluginDir);
		// The config schema travels with the loaded plugin module (`defineConfig`).
		const definition = this.registry.get(pluginId)?.configDefinition;

		const fields: PluginConfigField[] =
			definition?.descriptors && definition.descriptors.length > 0 ? [...definition.descriptors] : inferFieldsFromConfig(config);

		return {
			id: manifest.id,
			name: manifest.name,
			version: manifest.version,
			...(manifest.description ? { description: manifest.description } : {}),
			config: redactSecretValues(config, fields),
			fields,
		};
	}

	async savePluginConfig(pluginId: string, updatedConfig: Record<string, unknown>): Promise<PluginConfigDetails> {
		const dirName = await this.resolvePluginDirectoryName(pluginId);
		const pluginDir = this.config.resolvePluginDirectory(dirName);
		// Validate the merged result (not the patch): a redacted secret omitted by
		// the admin form must keep its stored value, and required fields must be
		// evaluated against what will actually be persisted.
		const definition = this.registry.get(pluginId)?.configDefinition;
		if (definition) {
			const existing = await this.config.load(pluginDir);
			definition.parse({ ...existing, ...updatedConfig });
		}

		await this.config.save(dirName, updatedConfig);
		try {
			await this.reload(pluginId);
		} catch {
			// If plugin wasn't loaded or failed, continue
		}

		return await this.getPluginConfigDetails(pluginId);
	}
}

/**
 * Omits secret fields from the config returned to clients. Omitting (not
 * masking) keeps `savePluginConfig`'s merge semantics intact — a key that is
 * absent from the payload is left unchanged on disk.
 */
function redactSecretValues(config: Record<string, unknown>, fields: readonly PluginConfigField[]): Record<string, unknown> {
	const secretKeys = new Set<string>();
	for (const field of fields) {
		if (field.type === "secret") secretKeys.add(field.name);
	}

	if (secretKeys.size === 0) return config;

	const redacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (!secretKeys.has(key)) redacted[key] = value;
	}

	return redacted;
}

function inferFieldsFromConfig(config: Record<string, unknown>): PluginConfigField[] {
	return Object.entries(config).map(([key, value]) => {
		const label = key
			.replaceAll(CAMEL_CASE_SPLIT_REGEX, " $1")
			.replace(CAPITALIZE_FIRST_REGEX, (str) => str.toUpperCase())
			.trim();
		if (typeof value === "boolean") {
			return { name: key, type: "boolean", label, default: value };
		}

		if (typeof value === "number") {
			return { name: key, type: "number", label, default: value };
		}

		if (typeof value === "string") {
			const keyLower = key.toLowerCase();
			const isSecret = SECRET_KEYWORDS.some((kw) => keyLower.includes(kw));
			// Never echo a secret value back as a field default: `fields` is
			// returned unredacted (unlike `config`), so a plain `default: value`
			// would leak the stored API key/token to the client.
			if (isSecret) return { name: key, type: "secret", label };

			return { name: key, type: "string", label, default: value };
		}

		return { name: key, type: "string", label, default: JSON.stringify(value) };
	});
}
