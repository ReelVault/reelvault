import type { InstallCatalogPluginResponse, PluginConfigDetails, PluginInstallDirection } from "@reelvault/sdk/common";
import type { PluginConfigField, PluginRuntime, PluginStatus, SubtitleProvider, SubtitleProviderStatus } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/server.config";
import { errorMessage, ValidationError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { Mutex } from "@/utils/mutex";
import { isNewerVersion } from "@/utils/semver.utils";
import { PluginConfig } from "../plugin.config";
import { type InstalledPlugin, type InstalledPluginRecord, PluginInstaller } from "../plugin.installer";
import { PluginLoader } from "../plugin.loader";
import { loadPluginManifest } from "../plugin.manifest";
import { type PluginRegistry, pluginRegistry } from "../plugin.registry";
import { createPluginStatus, pluginErrorCode } from "../plugin.status";
import { pluginUiSettingsService } from "../plugin-ui-settings.service";

const CAPITALIZE_FIRST_REGEX = /^./;
const CAMEL_CASE_SPLIT_REGEX = /([A-Z])/g;
const SECRET_KEYWORDS = ["key", "secret", "token", "password"];
/** SDK config errors read `Plugin configuration '<field>' …`; surface the field. */
const PLUGIN_CONFIG_FIELD_REGEX = /Plugin configuration '([^']+)'/;

function pluginConfigField(error: unknown): string | undefined {
	return PLUGIN_CONFIG_FIELD_REGEX.exec(errorMessage(error))?.[1];
}

function byStatusName(a: PluginStatus, b: PluginStatus): number {
	return a.name.localeCompare(b.name);
}

export interface PluginPackageDetails {
	capabilities: string[];
	configReadError?: string;
	installedAt?: string;
	source?: string;
	integrityOk?: boolean;
}

class ConfigRequiredError extends Error {
	readonly field: string;

	constructor(field: string) {
		super(`Plugin configuration '${field}' is required`);
		this.field = field;
	}
}

/** Unset, null or whitespace-only — a required field holding any of these has not been filled in. */
function isBlankConfigValue(value: unknown): boolean {
	return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
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
	/** Plugins whose package did not match its lockfile record at the last integrity check. */
	private readonly integrityIssues = new Set<string>();

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
			this.integrityIssues.clear();
			for (const pluginId of refreshed) this.integrityIssues.add(pluginId);
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
			if (manifest.id === pluginId) {
				return createPluginStatus({
					id: manifest.id,
					name: manifest.name,
					version: manifest.version,
					state: "disabled",
					description: manifest.description,
				});
			}
		} catch {
			// A missing or broken manifest falls back to the lockfile identity below.
		}

		return createPluginStatus({ id: pluginId, name: pluginId, version: record.version, state: "disabled" });
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
				} catch (error) {
					// A failed load leaves the plugin in the failed registry bucket — it must not linger as disabled.
					this.disabledStatuses.delete(pluginId);
					// An upgrade that does not load goes back to the package it replaced.
					const restored = await this.rollBackUpgrade(pluginId);
					if (!restored) throw error;

					throw new ValidationError(`Plugin ${pluginId} did not load; version ${restored.version} was restored`, {
						code: "plugin.upgrade_rolled_back",
						params: { pluginId, version: restored.version },
					});
				}
				this.disabledStatuses.delete(pluginId);
				await this.confirmUpgrade(pluginId);
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
			? createPluginStatus({
					id: runtime.manifest.id,
					name: runtime.manifest.name,
					version: runtime.manifest.version,
					state: "disabled",
					description: runtime.manifest.description,
				})
			: undefined;
	}

	private async statusFromManifest(pluginId: string): Promise<PluginStatus | undefined> {
		const dirName = (await this.loader.findDirectoryNameForPluginId(pluginId)) ?? pluginId;
		try {
			const manifest = await loadPluginManifest(this.config.resolvePluginDirectory(dirName));
			if (manifest.id !== pluginId) return undefined;

			return createPluginStatus({
				id: manifest.id,
				name: manifest.name,
				version: manifest.version,
				state: "disabled",
				description: manifest.description,
			});
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

	/** What the admin view shows about a plugin's package, beyond its runtime status. */
	async getPackageDetails(pluginId: string): Promise<PluginPackageDetails> {
		const dirName = await this.resolvePluginDirectoryName(pluginId);
		const directory = this.config.resolvePluginDirectory(dirName);
		const configReadError = await this.config.readError(directory);
		const installed = await this.installer
			.list()
			.then((records) => records.find((entry) => entry.id === pluginId)?.record)
			.catch(() => null);

		return {
			capabilities: await this.declaredCapabilities(pluginId, directory),
			...(configReadError ? { configReadError } : {}),
			...(installed
				? { installedAt: installed.installedAt, source: installed.source, integrityOk: !this.integrityIssues.has(pluginId) }
				: {}),
		};
	}

	/** The loaded manifest when there is one; otherwise the one on disk, so a failed or disabled plugin still reports its capabilities. */
	private async declaredCapabilities(pluginId: string, directory: string): Promise<string[]> {
		const runtime = this.registry.get(pluginId);
		if (runtime) return runtime.manifest.capabilities;

		try {
			return (await loadPluginManifest(directory)).capabilities;
		} catch {
			return [];
		}
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
			await this.loader.prepareUninstall(pluginId);
			try {
				// Package first: if removing the directory/lockfile fails, the plugin
				// is still installed and its data must survive. The reverse order
				// wiped user data and then left a package that looked installed.
				// Manually dropped plugins have no lockfile record — their data is
				// removed below regardless.
				await this.installer.uninstall(pluginId);
			} catch (error) {
				if (!(error instanceof ValidationError)) throw error;

				this.logger.warn(`No installer record for ${pluginId} — removed loaded data only`);
			}

			await this.loader.removePluginData(pluginId);
			await pluginUiSettingsService.reset(pluginId);

			// Cleared only after the installer succeeded — a failed uninstall leaves the plugin installed.
			this.disabledStatuses.delete(pluginId);
		});
	}

	/**
	 * Installs (or upgrades) a plugin package from an unpacked directory and brings
	 * the plugin to the state it should be in: running, or still disabled if the
	 * administrator had switched it off. A new version that does not load is rolled
	 * back to the package it replaced.
	 */
	async installFromDirectory(sourceDirectory: string, options: { source?: string }): Promise<InstallCatalogPluginResponse> {
		return await this.lifecycleMutex.runExclusive(async () => {
			const previousRecords = await this.installer.list();
			const result = await this.installer.install(sourceDirectory, {
				upgrade: true,
				...(options.source !== undefined ? { source: options.source } : {}),
			});
			this.integrityIssues.delete(result.id);

			const previous = previousRecords.find(({ id }) => id === result.id)?.record;
			const outcome = {
				pluginId: result.id,
				version: result.record.version,
				upgraded: previous !== undefined,
				direction: installDirection(previous?.version, result.record.version),
				...(previous ? { previousVersion: previous.version } : {}),
			};

			// The fresh record carries no disabled flag, so an upgrade would silently re-enable a plugin
			// the administrator switched off — carry the flag over. Such a plugin is not loaded until it is enabled.
			if (previous?.disabled === true) {
				await this.installer.setDisabled(result.id, true);
				this.disabledStatuses.set(result.id, await this.disabledStatusFromRecord(result.id, { ...result.record, disabled: true }));

				return { ...outcome, state: "disabled" };
			}
			this.disabledStatuses.delete(result.id);

			try {
				await this.activateInstalled(result.id, result.record.directory);

				return { ...outcome, state: "enabled" };
			} catch (error) {
				// The recorded failure is what the admin sees, so report that rather than the raw error.
				const failure = this.getStatus().find((status) => status.id === result.id);
				const failed = {
					...outcome,
					error: failure?.error ?? errorMessage(error),
					errorCode: failure?.errorCode ?? pluginErrorCode(error),
				};

				const restored = await this.rollBackUpgrade(result.id);
				if (restored) return { ...failed, version: restored.version, state: "rolled_back" };

				return { ...failed, state: "failed" };
			}
		});
	}

	/**
	 * Loads the installed package. A plugin already in the registry still runs the
	 * build it was loaded with, so it is reloaded. Calls the loader directly —
	 * `this.reload` would re-enter the same lock.
	 */
	private async activateInstalled(pluginId: string, directoryName: string): Promise<void> {
		if (this.registry.get(pluginId)) await this.loader.reloadPlugin(pluginId);
		else await this.loader.load(directoryName);

		await this.confirmUpgrade(pluginId);
	}

	/** The new version runs, so the package it replaced is no longer needed and stale interface switches can go. */
	private async confirmUpgrade(pluginId: string): Promise<void> {
		if (!(await this.installer.confirmUpgrade(pluginId))) return;

		await pluginUiSettingsService.pruneStale(pluginId);
	}

	/**
	 * Restores the package an unconfirmed upgrade replaced and loads it again.
	 * Returns the restored record, or undefined when there is nothing to roll back to.
	 */
	private async rollBackUpgrade(pluginId: string): Promise<InstalledPluginRecord | undefined> {
		let restored: InstalledPluginRecord | undefined;
		try {
			restored = await this.installer.rollbackUpgrade(pluginId);
		} catch (error) {
			this.logger.error(`Plugin ${pluginId} could not be rolled back to its previous version`, error);

			return undefined;
		}
		if (!restored) return undefined;

		if (restored.disabled === true) {
			this.disabledStatuses.set(pluginId, await this.disabledStatusFromRecord(pluginId, restored));

			return restored;
		}

		this.disabledStatuses.delete(pluginId);
		try {
			await this.loader.load(restored.directory);
		} catch (error) {
			this.logger.error(`Plugin ${pluginId} was restored to ${restored.version} but failed to load`, error);
		}

		return restored;
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

	getSubtitleProviders(): SubtitleProvider[] {
		return this.registry.getSubtitleProviders();
	}

	getSubtitleProviderStatus(): SubtitleProviderStatus[] {
		return this.registry.getSubtitleProviderStatus();
	}

	getSubtitleProvider(providerId: string): SubtitleProvider | undefined {
		return this.registry.getSubtitleProvider(providerId);
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
		// The config schema travels with the loaded plugin module (`defineConfig`);
		// a failed load keeps its definition too, so the plugin stays configurable.
		const definition = this.registry.getConfigDefinition(pluginId);

		const fields: PluginConfigField[] =
			definition?.descriptors && definition.descriptors.length > 0 ? [...definition.descriptors] : inferFieldsFromConfig(config);

		return {
			id: manifest.id,
			name: manifest.name,
			version: manifest.version,
			...(manifest.description ? { description: manifest.description } : {}),
			config: redactSecretValues(config, fields),
			fields: markSecretPresence(fields, config),
		};
	}

	async savePluginConfig(pluginId: string, updatedConfig: Record<string, unknown>): Promise<PluginConfigDetails> {
		const dirName = await this.resolvePluginDirectoryName(pluginId);
		const pluginDir = this.config.resolvePluginDirectory(dirName);
		// Validate the merged result (not the patch): a redacted secret omitted by
		// the admin form must keep its stored value, and required fields must be
		// evaluated against what will actually be persisted. A failed load keeps
		// its config definition, so validation works there too.
		const definition = this.registry.getConfigDefinition(pluginId);
		let pruneTo: ReadonlySet<string> | undefined;
		if (definition) {
			// Drop keys outside the declared schema so arbitrary junk from a stale
			// client can never reach config.json (or the plugin's parsed config).
			// The stored config is pruned with the same rule, cleaning up junk
			// persisted before this guard existed.
			pruneTo = new Set(definition.descriptors.map((descriptor) => descriptor.name));

			const existing = await this.config.load(pluginDir);
			try {
				const parsed = definition.parse({ ...existing, ...updatedConfig });
				// `required` is a UI/save-time contract: loading must still work for a plugin whose
				// key has not been entered yet, but an admin cannot save a form that leaves it blank.
				const blank = definition.descriptors.find(
					(descriptor) => descriptor.required === true && isBlankConfigValue(parsed[descriptor.name]),
				);
				if (blank) throw new ConfigRequiredError(blank.name);
			} catch (error) {
				const field = error instanceof ConfigRequiredError ? error.field : pluginConfigField(error);

				throw new ValidationError(errorMessage(error), {
					code: "plugin.config_invalid",
					...(field ? { params: { field } } : {}),
				});
			}
		}

		await this.config.save(dirName, updatedConfig, pruneTo);
		try {
			await this.reload(pluginId);
		} catch (error) {
			// The config is saved either way; surface why the plugin did not pick it up.
			this.logger.warn(`Plugin ${pluginId} saved its configuration but failed to reload`, { error });
		}

		return await this.getPluginConfigDetails(pluginId);
	}
}

/** A secret is never returned, so its field only says whether a non-blank value is stored. */
function markSecretPresence(fields: readonly PluginConfigField[], config: Record<string, unknown>): PluginConfigField[] {
	return fields.map((field) => (field.type === "secret" ? { ...field, hasValue: !isBlankConfigValue(config[field.name]) } : field));
}

/** Direction of an install relative to the version it replaces. An unordered pair is a plain replacement. */
function installDirection(previousVersion: string | undefined, version: string): PluginInstallDirection {
	if (previousVersion === undefined) return "install";
	if (previousVersion === version) return "reinstall";

	return isNewerVersion(previousVersion, version) ? "downgrade" : "upgrade";
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
