import type { PluginStatus } from "@reelvault/sdk/plugin";
import type { InstalledPlugin, InstalledPluginRecord } from "@/plugins/lifecycle/plugin.installer";
import { loadPluginManifest } from "@/plugins/lifecycle/plugin.manifest";
import { errorMessage } from "@/utils/domain.errors";
import { disabledStatus, type PluginManagerState } from "./state.utils";

/** The loader skips lockfile-disabled plugins entirely — without this seed they would be invisible to the admin API. */
export async function seedDisabledStatuses(state: PluginManagerState): Promise<void> {
	state.disabledStatuses.clear();
	let installed: InstalledPlugin[] = [];
	try {
		installed = await state.installer.list();
	} catch (error) {
		state.logger.warn("Disabled plugin seeding skipped — lockfile unreadable", { error: errorMessage(error) });

		return;
	}

	for (const { id, record } of installed) {
		// The admin's CSP choice applies whether or not the plugin is enabled.
		state.registry.setCspDisabled(id, record.cspDisabled === true);

		if (record.disabled !== true) continue;

		state.disabledStatuses.set(id, await disabledStatusFromRecord(state, id, record));
	}
}

/** Status of a lockfile-disabled plugin: from its manifest when readable, otherwise from the lockfile identity. */
export async function disabledStatusFromRecord(
	state: PluginManagerState,
	pluginId: string,
	record: InstalledPluginRecord,
): Promise<PluginStatus> {
	return (
		(await manifestStatus(state, pluginId, record.directory)) ?? disabledStatus({ id: pluginId, name: pluginId, version: record.version })
	);
}

/** Status of a loaded plugin, read from the registry before it is unloaded. */
export function statusFromRegistry(state: PluginManagerState, pluginId: string): PluginStatus | undefined {
	const runtime = state.registry.get(pluginId);
	if (!runtime) return undefined;

	const { manifest } = runtime;

	return disabledStatus({ id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description });
}

/** Status of a plugin that is installed but not loaded, read from its manifest on disk. */
export async function statusFromManifest(
	state: PluginManagerState,
	pluginId: string,
	directoryName: string,
): Promise<PluginStatus | undefined> {
	return await manifestStatus(state, pluginId, directoryName);
}

/** Manifest-derived disabled status; undefined when the manifest is unreadable or belongs to another plugin. */
async function manifestStatus(state: PluginManagerState, pluginId: string, directoryName: string): Promise<PluginStatus | undefined> {
	try {
		const manifest = await loadPluginManifest(state.config.resolvePluginDirectory(directoryName));
		if (manifest.id !== pluginId) return undefined;

		return disabledStatus({ id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description });
	} catch {
		return undefined;
	}
}
