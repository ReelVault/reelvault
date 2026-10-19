import type { PluginLockfile } from "@/plugins/lifecycle/installer/lockfile.store";
import { loadPluginManifest } from "@/plugins/lifecycle/plugin.manifest";
import { DirUtils } from "@/utils/directory.utils";
import { PathUtils } from "@/utils/path.utils";
import { isPluginDirectoryName } from "./plugin-directory.indexer";

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
		PathUtils.getFileName(record.directory) === record.directory &&
		(await DirUtils.exists(PathUtils.join(pluginsDirectory, record.directory)))
	) {
		return record.directory;
	}

	for (const dirName of await DirUtils.listDirs(pluginsDirectory)) {
		if (!isPluginDirectoryName(dirName)) continue;

		try {
			const manifest = await loadPluginManifest(PathUtils.join(pluginsDirectory, dirName));
			if (manifest.id === pluginId) return dirName;
		} catch {
			// Not a loadable plugin directory — ignore.
		}
	}

	return undefined;
}
