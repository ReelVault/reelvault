import { seedDisabledStatuses } from "./disabled.service";
import type { PluginManagerState } from "./state.utils";

/**
 * Advisory integrity check against `plugins.lock.json` (only installer-managed
 * plugins have lockfile entries). Never blocks boot: a package edited
 * out-of-band (a plugin directory refreshed by hand) or a lockfile written
 * under an older hash scheme is reconciled by rewriting the stale record, so
 * the mismatch is reported once instead of spamming every startup.
 */
async function verifyInstalledPlugins(state: PluginManagerState): Promise<void> {
	try {
		const refreshed = await state.installer.refreshIntegrity();
		state.integrityIssues.clear();
		for (const pluginId of refreshed) state.integrityIssues.add(pluginId);
		if (refreshed.length > 0) {
			state.logger.warn("Plugin integrity changed — lockfile records refreshed", { plugins: refreshed });
		}
	} catch (error) {
		state.logger.error("Plugin integrity verification failed", error);
	}
}

/** Boot: verify the packages, seed the disabled plugins, then load everything that is enabled. */
export async function loadInstalledPlugins(state: PluginManagerState): Promise<void> {
	await verifyInstalledPlugins(state);
	await seedDisabledStatuses(state);
	await state.loader.loadAll();
}
