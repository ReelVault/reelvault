import type { InstallCatalogPluginResponse, PluginConfigDetails } from "@reelvault/sdk/common";
import type { PluginRuntime, PluginStatus, SubtitleProvider, SubtitleProviderStatus } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { PluginConfig } from "@/plugins/lifecycle/plugin.config";
import { PluginInstaller } from "@/plugins/lifecycle/plugin.installer";
import { PluginLoader } from "@/plugins/lifecycle/plugin.loader";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { KeyedMutex } from "@/utils/concurrency.utils";
import { createLogger } from "@/utils/logger.utils";
import { getPluginConfigDetails, loadStoredConfig, writePluginConfig } from "./config.service";
import { loadPlugin, reloadAllPlugins, reloadPlugin, setPluginEnabled, uninstallPlugin, unloadPlugin } from "./lifecycle.service";
import { getPackageDetails, type PluginPackageDetails } from "./package.reader";
import { loadInstalledPlugins } from "./startup.service";
import type { PluginManagerState } from "./state.utils";
import { getStatus } from "./status.reader";
import { installFromDirectory } from "./upgrade.service";

export class PluginManager {
	private readonly state: PluginManagerState;

	constructor() {
		const config = new PluginConfig();
		const registry = pluginRegistry;
		const loader = new PluginLoader(config, registry);
		this.state = {
			logger: createLogger("PluginManager"),
			config,
			registry,
			loader,
			installer: new PluginInstaller(serverConfig.paths.plugins),
			lifecycleMutex: new KeyedMutex(),
			disabledStatuses: new Map<string, PluginStatus>(),
			integrityIssues: new Set<string>(),
		};
	}

	async loadPlugins(): Promise<void> {
		await loadInstalledPlugins(this.state);
	}

	/**
	 * Persists the enabled/disabled state and (un)loads under one lock; see {@link setPluginEnabled}.
	 */
	async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
		await setPluginEnabled(this.state, pluginId, enabled);
	}

	/** Full reload: unload every plugin first, then load them again. */
	async reloadAll(): Promise<void> {
		await reloadAllPlugins(this.state);
	}

	/** Resolves a plugin id to its on-disk directory name (used for serving plugin statics). */
	async getPluginDirectoryName(pluginId: string): Promise<string | undefined> {
		return await this.state.loader.findDirectoryNameForPluginId(pluginId);
	}

	/** What the admin view shows about a plugin's package, beyond its runtime status. */
	async getPackageDetails(pluginId: string): Promise<PluginPackageDetails> {
		return await getPackageDetails(this.state, pluginId);
	}

	async load(pluginName: string): Promise<void> {
		await loadPlugin(this.state, pluginName);
	}

	async reload(pluginId: string): Promise<void> {
		await reloadPlugin(this.state, pluginId);
	}

	async unload(pluginId: string): Promise<void> {
		await unloadPlugin(this.state, pluginId);
	}

	/** Admin choice: keep the installed version or allow catalog updates again. Persisted. */
	async setPluginPinned(pluginId: string, pinned: boolean): Promise<void> {
		await this.state.installer.setPinned(pluginId, pinned);
	}

	/** Admin choice: refuse or allow the CSP sources the plugin declares. Persisted and applied at once. */
	async setPluginCspDisabled(pluginId: string, disabled: boolean): Promise<void> {
		await this.state.installer.setCspDisabled(pluginId, disabled);
		this.state.registry.setCspDisabled(pluginId, disabled);
	}

	async uninstall(pluginId: string): Promise<void> {
		await uninstallPlugin(this.state, pluginId);
	}

	/**
	 * Installs (or upgrades) a plugin package from an unpacked directory and brings
	 * the plugin to the state it should be in; see {@link installFromDirectory}.
	 */
	async installFromDirectory(sourceDirectory: string, options: { source?: string }): Promise<InstallCatalogPluginResponse> {
		return await installFromDirectory(this.state, sourceDirectory, options);
	}

	/** Installer-managed plugins, including disabled and currently-unloaded ones. */
	async getInstalledRecords() {
		return await this.state.installer.list();
	}

	async shutdown(): Promise<void> {
		await this.state.loader.unloadAll();
	}

	getPlugin(id: string): PluginRuntime | undefined {
		return this.state.registry.get(id);
	}

	getStatus(): PluginStatus[] {
		return getStatus(this.state);
	}

	getSubtitleProviders(): SubtitleProvider[] {
		return this.state.registry.getSubtitleProviders();
	}

	getSubtitleProviderStatus(): SubtitleProviderStatus[] {
		return this.state.registry.getSubtitleProviderStatus();
	}

	getSubtitleProvider(providerId: string): SubtitleProvider | undefined {
		return this.state.registry.getSubtitleProvider(providerId);
	}

	async getPluginConfigDetails(pluginId: string): Promise<PluginConfigDetails> {
		return await getPluginConfigDetails(this.state, pluginId);
	}

	/**
	 * Restores the defaults for `keys` (every stored value when omitted) by removing them from the
	 * stored config. Goes through the same validation as a save, so a reset that would leave a
	 * required field blank is refused.
	 */
	async resetPluginConfig(pluginId: string, keys?: readonly string[]): Promise<PluginConfigDetails> {
		const existing = await loadStoredConfig(this.state, pluginId);

		return await this.savePluginConfig(pluginId, {}, { remove: keys ?? Object.keys(existing) });
	}

	async savePluginConfig(
		pluginId: string,
		updatedConfig: Record<string, unknown>,
		options: { remove?: readonly string[] } = {},
	): Promise<PluginConfigDetails> {
		await writePluginConfig(this.state, pluginId, updatedConfig, options.remove ?? []);

		return await this.getPluginConfigDetails(pluginId);
	}
}
