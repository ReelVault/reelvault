import type { PluginManifest } from "@reelvault/sdk/plugin";
import { loadPluginManifest } from "@/plugins/lifecycle/plugin.manifest";
import { listDirectories } from "@/utils/directory.utils";
import { joinPath } from "@/utils/path.utils";
import { isPluginDirectoryName } from "./plugin-directory.indexer";

/**
 * Walks the plugins root and yields every loadable manifest with its directory.
 * An unreadable or non-plugin directory is skipped; callers that need a first
 * match, an index or duplicate cleanup share this one walk.
 */
export async function* readPluginManifests(pluginsDirectory: string): AsyncGenerator<{ directoryName: string; manifest: PluginManifest }> {
	for (const directoryName of await listDirectories(pluginsDirectory)) {
		if (!isPluginDirectoryName(directoryName)) continue;

		try {
			yield { directoryName, manifest: await loadPluginManifest(joinPath(pluginsDirectory, directoryName)) };
		} catch {
			// Not a loadable plugin directory — ignore.
		}
	}
}
