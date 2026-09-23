import { copyFile, link, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { PathUtils } from "@/utils/path.utils";

/**
 * Bun's ESM loader caches modules by resolved path (query strings are ignored)
 * and does not run `Bun.plugin` hooks for the runtime ESM loader. A plain
 * `import(entry)` therefore reuses the previous build after an in-place plugin
 * upgrade — `reload` re-ran `setup()` but against the OLD module instance.
 *
 * Materialising the plugin directory into a unique, hard-linked mirror gives
 * every load a fresh module graph (relatives included), so an updated build
 * actually executes. Hard links make the mirror metadata-only; `copyFile` is
 * the cross-filesystem fallback.
 */
const RUNTIME_DIRECTORY_NAME = ".runtime";
const SKIPPED_DIRECTORY_NAMES = new Set([".git"]);

export function pluginRuntimeRoot(pluginsDirectory: string): string {
	return PathUtils.join(pluginsDirectory, RUNTIME_DIRECTORY_NAME);
}

/** Wipes every materialised runtime. Called on boot before the first load. */
export async function clearPluginRuntimes(runtimeRoot: string): Promise<void> {
	await rm(runtimeRoot, { recursive: true, force: true });
}

/** Creates a unique path that imports a fresh module graph for `pluginDir`. */
export async function materializePluginRuntime(pluginDir: string, runtimeRoot: string): Promise<string> {
	const runtimeDir = PathUtils.join(runtimeRoot, crypto.randomUUID());
	await mirrorDirectory(pluginDir, runtimeDir, new Set());

	return runtimeDir;
}

/** Removes a single materialised runtime (the source directory is untouched). */
export async function removePluginRuntime(runtimeDir: string | undefined): Promise<void> {
	if (!runtimeDir) return;

	await rm(runtimeDir, { recursive: true, force: true });
}

async function mirrorDirectory(source: string, destination: string, visitedRealPaths: Set<string>): Promise<void> {
	await mkdir(destination, { recursive: true });
	const entries = await readdir(source, { withFileTypes: true });

	for (const entry of entries) {
		if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;

		const from = PathUtils.join(source, entry.name);
		const to = PathUtils.join(destination, entry.name);

		if (entry.isDirectory()) {
			await mirrorDirectory(from, to, visitedRealPaths);
			continue;
		}

		if (entry.isFile()) {
			await linkOrCopy(from, to);
			continue;
		}

		if (!entry.isSymbolicLink()) continue;

		// Dereference symlinks (legacy/dev installs) with a cycle guard; the
		// installer rejects symlinked packages, so this is a convenience only.
		const real = await realpath(from).catch(() => null);
		if (!real || visitedRealPaths.has(real)) continue;

		const info = await stat(real).catch(() => null);
		if (info?.isDirectory()) {
			visitedRealPaths.add(real);
			await mirrorDirectory(real, to, visitedRealPaths);
			continue;
		}

		if (info?.isFile()) await linkOrCopy(real, to);
	}
}

async function linkOrCopy(from: string, to: string): Promise<void> {
	try {
		await link(from, to);
	} catch {
		await copyFile(from, to);
	}
}
