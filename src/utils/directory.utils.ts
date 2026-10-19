import { rmSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { file as bunFile, Glob } from "bun";
import { FS_STAT_TIMEOUT_MS } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { isMissingFile } from "./domain.errors";
import { createLogger } from "./logger.utils";
import { MemoryCache } from "./memory.cache";
import { PathUtils } from "./path.utils";
import { PromiseTimeoutError, PromiseUtils } from "./promise.utils";

const logger = createLogger("DirUtils");

/**
 * Paths held while stat-ing a directory walk. The walk used to collect every
 * path first and stat them second, which doubled the peak for a large library;
 * a batch keeps the same concurrency without the full path array.
 */
const STAT_BATCH_SIZE = 512;

/** Removes a file or directory tree; a missing path is not an error. */
export function removeTree(path: string): Promise<void> {
	return rm(path, { recursive: true, force: true });
}

/** Synchronous counterpart of `removeTree`; a missing path is not an error. */
export function removeTreeSync(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

export interface ScannedFileEntry {
	filePath: string;
	size: number;
	mtimeMs: number;
}

export const DirUtils = {
	async exists(path: string): Promise<boolean> {
		try {
			const stats = await PromiseUtils.withTimeout(bunFile(path).stat(), FS_STAT_TIMEOUT_MS, `stat ${path}`);

			return stats.isDirectory();
		} catch (error) {
			// A hung stat must not wedge watcher reconciliation — report "not a
			// directory" so the caller records a failure and arms its fallback.
			if (error instanceof PromiseTimeoutError) {
				logger.warn("Directory existence check timed out", { directoryPath: path });
			}

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

			await removeTree(path);

			return true;
		} catch (error) {
			// A missing directory is already deleted — deleting is idempotent, so a
			// cleanup of an already-removed temp dir must not log an error.
			if (isMissingFile(error)) return true;

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
		const ioConcurrency = systemResourcesService.getIoConcurrency();
		const results: ScannedFileEntry[] = [];
		let batch: string[] = [];

		const flush = async (): Promise<void> => {
			if (batch.length === 0) return;

			const paths = batch;
			batch = [];
			const entries = await PromiseUtils.mapConcurrent(
				paths,
				ioConcurrency,
				async (fullPath) => {
					try {
						const fileStat = await bunFile(fullPath).stat();

						return {
							filePath: fullPath,
							size: fileStat.size,
							mtimeMs: Math.floor(fileStat.mtimeMs),
						};
					} catch {
						// File vanished between listing and stat — skip it.
						return null;
					}
				},
				signal,
			);
			for (const entry of entries) {
				if (entry) results.push(entry);
			}
		};

		try {
			for await (const fullPath of iterateGlob(basePath, extensions, maxDepth, signal, options)) {
				batch.push(fullPath);
				if (batch.length >= STAT_BATCH_SIZE) await flush();
			}
			await flush();

			return results;
		} catch (error) {
			if (signal?.aborted) throw error;

			logger.error("Scan directory error", error, { directoryPath: basePath, extensions, maxDepth });

			return [];
		}
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
