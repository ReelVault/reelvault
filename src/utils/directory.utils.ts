import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { Glob } from "bun";
import { systemResourcesService } from "@/system/system-resources.service";
import { createLogger } from "./logger";
import { MemoryCache } from "./memory-cache";
import { PathUtils } from "./path.utils";
import { PromiseUtils } from "./promise.utils";

const logger = createLogger("DirUtils");

export interface ScannedFileEntry {
	filePath: string;
	size: number;
	mtimeMs: number;
}

export const DirUtils = {
	async exists(path: string): Promise<boolean> {
		try {
			const stats = await stat(path);

			return stats.isDirectory();
		} catch {
			return false;
		}
	},

	async create(path: string): Promise<boolean> {
		try {
			await mkdir(path, { recursive: true });

			return true;
		} catch (error) {
			logger.error("Create directory error", error, { directoryPath: path });

			return false;
		}
	},

	async delete(path: string, options?: { allowVideo?: boolean }): Promise<boolean> {
		try {
			if (!options?.allowVideo && (await containsVideoFile(path))) {
				logger.warn("Refusing to delete directory containing video files", { directoryPath: path });

				return false;
			}

			await rm(path, { recursive: true, force: true });

			return true;
		} catch (error) {
			logger.error("Delete directory error", error, { directoryPath: path });

			return false;
		}
	},

	/**
	 * Deletes an application-owned temporary directory, including generated
	 * video files. Only use this for directories whose contents can be
	 * recreated, such as an HLS/transcoding session directory.
	 */
	async deleteTemporary(path: string): Promise<boolean> {
		return await DirUtils.delete(path, { allowVideo: true });
	},

	async scanFiles(
		basePath: string,
		extensions: readonly string[],
		maxDepth = 10,
		signal?: AbortSignal,
		options?: { dot?: boolean | undefined },
	): Promise<string[]> {
		try {
			return await collectGlobPaths(basePath, extensions, maxDepth, signal, options);
		} catch (error) {
			if (signal?.aborted) throw error;

			logger.error("Scan directory error", error, { directoryPath: basePath, extensions, maxDepth });

			return [];
		}
	},

	async scanFilesWithStats(
		basePath: string,
		extensions: readonly string[],
		maxDepth = 10,
		signal?: AbortSignal,
		options?: { dot?: boolean | undefined },
	): Promise<ScannedFileEntry[]> {
		const filePaths = await DirUtils.scanFiles(basePath, extensions, maxDepth, signal, options);
		if (filePaths.length === 0) return [];

		const results: ScannedFileEntry[] = [];
		await PromiseUtils.mapConcurrent(
			filePaths,
			systemResourcesService.getIoConcurrency(),
			async (fullPath) => {
				try {
					const fileStat = await stat(fullPath);
					results.push({
						filePath: fullPath,
						size: fileStat.size,
						mtimeMs: Math.floor(fileStat.mtimeMs),
					});
				} catch {
					// File vanished between listing and stat — skip it.
				}
			},
			signal,
		);

		return results;
	},

	async listDirs(basePath: string): Promise<string[]> {
		try {
			const entries = await readdir(basePath, { withFileTypes: true });

			return entries.filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			return [];
		}
	},
};

const globCache = new MemoryCache<Glob>({ ttlMs: -1, maxSize: 32, name: "glob-pattern" });

function getGlobForExtensions(extensions: readonly string[]): Glob {
	// Compiling a Glob is expensive and libraries contain thousands of
	// directories — reuse one instance per extension-set signature.
	const pattern = `**/*.{${extensions.map((extension) => extension.replace(".", "")).join(",")}}`;
	let glob = globCache.get(pattern);
	if (glob === null) {
		glob = new Glob(pattern);
		globCache.set(pattern, glob);
	}

	return glob;
}

function collectGlobPaths(
	basePath: string,
	extensions: readonly string[],
	maxDepth: number,
	signal?: AbortSignal,
	options?: { dot?: boolean | undefined },
): Promise<string[]> {
	return Array.fromAsync(iterateGlob(basePath, extensions, maxDepth, signal, options));
}

async function* iterateGlob(
	basePath: string,
	extensions: readonly string[],
	maxDepth: number,
	signal?: AbortSignal,
	options?: { dot?: boolean | undefined },
): AsyncIterableIterator<string> {
	const glob = getGlobForExtensions(extensions);
	// dot defaults to false: dot-prefixed files AND directories are treated as
	// non-media (hidden OS artifacts). Internal sweeps over server-owned roots
	// (e.g. the images dir with its .tmp/.cache) opt back in via options.dot.
	for await (const file of glob.scan({ cwd: basePath, onlyFiles: true, dot: options?.dot ?? false })) {
		if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");

		let depth = 1;
		for (let i = 0; i < file.length; i++) {
			if (file.charCodeAt(i) === 47) depth++;
		}

		if (depth > maxDepth) continue;

		yield PathUtils.join(basePath, file);
	}
}

async function containsVideoFile(path: string, maxDepth = 10, currentDepth = 0): Promise<boolean> {
	if (currentDepth >= maxDepth) return false;

	for (const entry of await readdir(path, { withFileTypes: true })) {
		const entryPath = PathUtils.join(path, entry.name);
		if (entry.isFile() && PathUtils.isVideoFile(entryPath)) return true;

		if (entry.isDirectory() && (await containsVideoFile(entryPath, maxDepth, currentDepth + 1))) return true;
	}

	return false;
}
