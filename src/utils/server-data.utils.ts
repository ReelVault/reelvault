import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { DirUtils } from "@/utils/directory.utils";
import { InternalError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";

const logger = createLogger("ServerDataUtils");

export async function ensureDataDirectories(): Promise<void> {
	if (!(await FileUtils.exists(serverConfig.paths.sqlite))) throw new InternalError("No database file", { code: "database.file_missing" });

	const directories = [
		serverConfig.paths.images,
		PathUtils.join(serverConfig.paths.images, "posters"),
		PathUtils.join(serverConfig.paths.images, "backdrops"),
		PathUtils.join(serverConfig.paths.images, "people"),
		PathUtils.join(serverConfig.paths.images, "profiles"),
		PathUtils.join(serverConfig.paths.images, "others"),
		PathUtils.join(serverConfig.paths.images, ".cache"),
		serverConfig.paths.imageTmp,
		serverConfig.paths.plugins,
		serverConfig.paths.downloads,
		serverConfig.paths.transcodes,
		serverConfig.paths.logs,
		serverConfig.paths.backups,
	];

	const creationResults = await PromiseUtils.mapConcurrent(directories, systemResourcesService.getIoConcurrency(), async (dir) => ({
		dir,
		created: await DirUtils.create(dir),
	}));
	// Boot continues (existing installs on odd mounts must not be locked out),
	// but the failure is reported once here instead of as scattered write errors.
	const failedDirs = creationResults.filter((entry) => !entry.created).map((entry) => entry.dir);
	if (failedDirs.length > 0) {
		logger.error("Failed to create data directories — writes into them will fail", { failedDirs });
	}
}

export async function cleanupStartupDirectories(
	targets?: string[],
	excludeEntryNames?: ReadonlySet<string>,
	signal?: AbortSignal,
): Promise<void> {
	// images/.cache is deliberately NOT wiped: it holds resized poster/backdrop
	// variants keyed by source mtime/size with its own eviction. Deleting it on
	// every boot would force a full artwork re-encode on first view after each
	// restart — a sustained CPU storm on weak hosts.
	const cleanupTargets = targets ?? [serverConfig.paths.transcodes, serverConfig.paths.imageTmp];

	for (const targetDir of cleanupTargets) {
		signal?.throwIfAborted();
		try {
			if (await DirUtils.exists(targetDir)) {
				const entries = await readdir(targetDir);
				// Bounded concurrency — an unbounded Promise.all over hundreds of
				// HLS sessions would flood the I/O thread pool right before listen().
				// Bounded by measured capacity — a slow disk/SD card must not queue
				// deep parallel unlink waves right at boot.
				await PromiseUtils.mapConcurrent(
					entries,
					systemResourcesService.getIoConcurrency(),
					(entry) => {
						if (excludeEntryNames?.has(entry)) return Promise.resolve();

						return rm(PathUtils.join(targetDir, entry), { recursive: true, force: true });
					},
					signal,
				);
			}

			await DirUtils.create(targetDir);
		} catch (err) {
			logger.warn("Failed to clean up startup directory", { targetDir, err });
		}
	}

	logger.info("Startup temporary directories cleaned up successfully");
}

/**
 * Total size and file count of a directory tree (symlinks excluded).
 *
 * ponytail: sequential stat walk, O(files); callers cache the result (60s TTL)
 * so this never sits on a request hot path — parallelize the stat loop if that changes.
 */
export async function measureDirectory(dir: string): Promise<{ bytes: number; files: number }> {
	const stack = [dir];
	const filePaths: string[] = [];

	while (stack.length > 0) {
		const current = stack.pop() ?? "";
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue; // directory vanished mid-walk or is unreadable — treat as empty
		}

		for (const entry of entries) {
			const entryPath = PathUtils.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
			} else if (entry.isFile()) {
				filePaths.push(entryPath);
			}
		}
	}

	const sizes = await PromiseUtils.mapConcurrent(filePaths, systemResourcesService.getIoConcurrency(), async (filePath) => {
		try {
			return (await stat(filePath)).size;
		} catch {
			// file vanished mid-measure — count it with zero bytes
			return 0;
		}
	});

	return { bytes: sizes.reduce((total, size) => total + size, 0), files: sizes.length };
}

interface MediaCleanupPlan {
	artifactStorageKeys: readonly string[];
	subtitleFilePaths: ReadonlyArray<string | null | undefined>;
	subtitleIds?: readonly string[] | undefined;
}

/**
 * Deletes artifact blobs, subtitle files and derived `<id>.vtt` paths after a
 * metadata/media-file/library delete. Subtitle paths outside the managed
 * directory are ignored; I/O fan-out is bounded by the configured budget.
 */
export async function runMediaCleanup(plan: MediaCleanupPlan): Promise<void> {
	const tasks: Array<() => Promise<unknown>> = [
		...plan.artifactStorageKeys.map((storageKey) => async () => FileUtils.delete(PathUtils.join(serverConfig.paths.artifacts, storageKey))),
		...plan.subtitleFilePaths
			.filter((filePath): filePath is string => Boolean(filePath && PathUtils.isSubpath(filePath, serverConfig.paths.subtitles)))
			.map((filePath) => async () => FileUtils.delete(filePath)),
		...(plan.subtitleIds ?? []).map((id) => async () => FileUtils.delete(PathUtils.join(serverConfig.paths.subtitles, `${id}.vtt`))),
	];

	await PromiseUtils.mapConcurrent(tasks, serverConfig.application.cleanupConcurrency, async (task) => task());
}
