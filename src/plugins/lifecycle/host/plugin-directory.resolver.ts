import type { PluginLockfile } from "@/plugins/lifecycle/installer/lockfile.store";
import { directoryExists } from "@/utils/directory.utils";
import { getFileName, joinPath } from "@/utils/path.utils";
import { isPluginDirectoryName } from "./plugin-directory.indexer";
import { readPluginManifests } from "./plugin-directory.reader";

/**
 * The directory a plugin id lives in.
 *
 * The lockfile record comes first — it records where the installer actually put
 * the plugin, and a manifest scan also sees stale duplicate directories with the
 * same id. A plugin that was dropped on disk is not in the lockfile, so the
 * manifest scan is the fallback.
 *
 * The loader and the installer both need this, and each of them wrote the
 * algorithm out again.
 */
export async function resolvePluginDirectoryName(
	pluginId: string,
	lockfile: PluginLockfile,
	pluginsDirectory: string,
): Promise<string | undefined> {
	const record = lockfile.plugins[pluginId];
	if (
		record &&
		isPluginDirectoryName(record.directory) &&
		getFileName(record.directory) === record.directory &&
		(await directoryExists(joinPath(pluginsDirectory, record.directory)))
	) {
		return record.directory;
	}

	for await (const { directoryName, manifest } of readPluginManifests(pluginsDirectory)) {
		if (manifest.id === pluginId) return directoryName;
	}

	return undefined;
}
