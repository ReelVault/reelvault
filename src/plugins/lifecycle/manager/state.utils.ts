import type { PluginStatus } from "@reelvault/sdk/plugin";
import type { PluginConfig } from "@/plugins/lifecycle/plugin.config";
import type { PluginInstaller } from "@/plugins/lifecycle/plugin.installer";
import type { PluginLoader } from "@/plugins/lifecycle/plugin.loader";
import type { PluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { createPluginStatus } from "@/plugins/lifecycle/plugin.status";
import type { KeyedMutex } from "@/utils/concurrency.utils";
import { DomainError } from "@/utils/domain.errors";
import type { createLogger } from "@/utils/logger.utils";
import { PromiseTimeoutError, withTimeout } from "@/utils/promise.utils";

/** One lifecycle operation may legitimately install a package; it may not run forever. */
const PLUGIN_LIFECYCLE_TIMEOUT_MS = 5 * 60_000;

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
	/**
	 * A lifecycle operation that missed its deadline may still be running. New
	 * lifecycle work is refused until restart instead of racing the orphan.
	 */
	lifecycleTimedOut: boolean;
}

/** Serialises install, upgrade, reload, enable and disable — they mutate the same directories and registry. */
const PLUGIN_LIFECYCLE_KEY = "plugin-lifecycle";

export async function runLifecycle<T>(state: PluginManagerState, fn: () => Promise<T>): Promise<T> {
	if (state.lifecycleTimedOut) {
		throw new DomainError("timeout", "A previous plugin lifecycle operation did not finish; restart the server to recover", {
			code: "plugin.lifecycle_unavailable",
		});
	}

	return await state.lifecycleMutex.runExclusive(PLUGIN_LIFECYCLE_KEY, async () => {
		try {
			return await withTimeout(fn(), PLUGIN_LIFECYCLE_TIMEOUT_MS, "plugin lifecycle");
		} catch (error) {
			if (error instanceof PromiseTimeoutError) {
				// The mutex gate is released when this throws, but the original
				// operation may still be alive. Refuse further lifecycle work
				// rather than letting two operations mutate the same directories.
				state.lifecycleTimedOut = true;
				throw new DomainError("timeout", "Plugin lifecycle operation exceeded its deadline", {
					cause: error,
					code: "plugin.lifecycle_timeout",
				});
			}

			throw error;
		}
	});
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
