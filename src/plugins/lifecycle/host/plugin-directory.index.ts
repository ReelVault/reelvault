import { serverConfig } from "@/server.config";
import { DirUtils } from "@/utils/directory.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { loadPluginManifest } from "../plugin.manifest";

/** `node_modules` (the SDK runtime shim) and dot-directories are never plugin packages. */
export function isPluginDirectoryName(name: string): boolean {
	return name !== "node_modules" && !name.startsWith(".");
}

/** Id→directory-name index over the plugins root, built from manifests and refreshed on demand. */
export class PluginDirectoryIndex {
	private readonly entries = new Map<string, string>();

	get(pluginId: string): string | undefined {
		return this.entries.get(pluginId);
	}

	set(pluginId: string, directoryName: string): void {
		this.entries.set(pluginId, directoryName);
	}

	delete(pluginId: string): void {
		this.entries.delete(pluginId);
	}

	/** Resolves a plugin id to its directory name, refreshing the index when the entry is missing or stale. */
	async resolve(pluginId: string, pluginsDirectory: string): Promise<string | undefined> {
		const indexed = this.entries.get(pluginId);
		if (indexed) {
			if (await DirUtils.exists(PathUtils.join(pluginsDirectory, indexed))) return indexed;

			this.entries.delete(pluginId);
		}

		await this.refresh(pluginsDirectory);

		return this.entries.get(pluginId);
	}

	/** Reads every plugin manifest once to build the id→directory index used by id-based lookups. */
	async refresh(pluginsDirectory: string): Promise<void> {
		const dirNames = (await DirUtils.listDirs(pluginsDirectory)).filter((name) => isPluginDirectoryName(name));
		const knownDirectories = new Set(this.entries.values());
		await PromiseUtils.mapConcurrent(dirNames, serverConfig.plugins.lifecycle.loadConcurrency, async (dirName) => {
			if (knownDirectories.has(dirName)) return;

			try {
				const manifest = await loadPluginManifest(PathUtils.join(pluginsDirectory, dirName));
				this.entries.set(manifest.id, dirName);
			} catch {
				// Not a loadable plugin directory — ignore.
			}
		});
	}
}
