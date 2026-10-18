import type { PluginStatus } from "@reelvault/sdk/plugin";
import type { PluginConfig } from "@/plugins/lifecycle/plugin.config";
import type { PluginInstaller } from "@/plugins/lifecycle/plugin.installer";
import type { PluginLoader } from "@/plugins/lifecycle/plugin.loader";
import type { PluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { createPluginStatus } from "@/plugins/lifecycle/plugin.status";
import type { KeyedMutex } from "@/utils/concurrency.utils";
import type { createLogger } from "@/utils/logger.utils";

/** Shared by every manager function: the collaborators and the bookkeeping they update. */
export interface PluginManagerState {
	readonly logger: ReturnType<typeof createLogger>;
	readonly config: PluginConfig;
	readonly registry: PluginRegistry;
	readonly loader: PluginLoader;
	readonly installer: PluginInstaller;
	/** Serialises lifecycle mutations (install/reload/enable/uninstall) across admin requests. */
	readonly lifecycleMutex: KeyedMutex;
	/** Installed but unloaded plugins — the registry only tracks loaded ones, so the disabled state lives here. */
	readonly disabledStatuses: Map<string, PluginStatus>;
	/** Plugins whose package did not match its lockfile record at the last integrity check. */
	readonly integrityIssues: Set<string>;
}

/** Serialises install, upgrade, reload, enable and disable — they mutate the same directories and registry. */
const PLUGIN_LIFECYCLE_KEY = "plugin-lifecycle";

export function runLifecycle<T>(state: PluginManagerState, fn: () => Promise<T>): Promise<T> {
	return state.lifecycleMutex.runExclusive(PLUGIN_LIFECYCLE_KEY, fn);
}

/** Resolves a plugin id to its on-disk directory name. A plugin id is NOT its directory name. */
export async function directoryNameOf(state: PluginManagerState, pluginId: string): Promise<string> {
	return (await state.loader.findDirectoryNameForPluginId(pluginId)) ?? pluginId;
}

export async function pluginDirectoryOf(state: PluginManagerState, pluginId: string): Promise<string> {
	return state.config.resolvePluginDirectory(await directoryNameOf(state, pluginId));
}

/** The status an installed plugin shows while it is not running. */
export function disabledStatus(identity: { id: string; name: string; version: string; description?: string | undefined }): PluginStatus {
	return createPluginStatus({ ...identity, state: "disabled" });
}
