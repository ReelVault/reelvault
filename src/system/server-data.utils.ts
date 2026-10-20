import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { file as bunFile } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { createDirectory, directoryExists, removeTree } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { fileExists } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { joinPath } from "@/utils/path.utils";
import { mapConcurrent } from "@/utils/promise.utils";

const logger = createLogger("ServerDataUtils");

export async function ensureDataDirectories(): Promise<void> {
	if (!(await fileExists(serverConfig.paths.sqlite)))
		throw new DomainError("internal", "No database file", { code: "database.file_missing" });

	const directories = [
		serverConfig.paths.images,
		joinPath(serverConfig.paths.images, "posters"),
		joinPath(serverConfig.paths.images, "backdrops"),
		joinPath(serverConfig.paths.images, "people"),
		joinPath(serverConfig.paths.images, "profiles"),
		joinPath(serverConfig.paths.images, "others"),
		joinPath(serverConfig.paths.images, ".cache"),
		serverConfig.paths.imageTmp,
		serverConfig.paths.plugins,
		serverConfig.paths.downloads,
		serverConfig.paths.transcodes,
		serverConfig.paths.logs,
		serverConfig.paths.backups,
	];

	const creationResults = await mapConcurrent(directories, systemResourcesService.getIoConcurrency(), async (dir) => ({
		dir,
		created: await createDirectory(dir),
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
			if (await directoryExists(targetDir)) {
				const entries = await readdir(targetDir);
				// Bounded concurrency — an unbounded Promise.all over hundreds of
				// HLS sessions would flood the I/O thread pool right before listen().
				// Bounded by measured capacity — a slow disk/SD card must not queue
				// deep parallel unlink waves right at boot.
				await mapConcurrent(
					entries,
					systemResourcesService.getIoConcurrency(),
					(entry) => {
						if (excludeEntryNames?.has(entry)) return Promise.resolve();

						return removeTree(joinPath(targetDir, entry));
					},
					signal,
				);
			}

			await createDirectory(targetDir);
		} catch (error) {
			logger.warn("Failed to clean up startup directory", { targetDir, err: error });
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
			const entryPath = joinPath(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
			} else if (entry.isFile()) {
				filePaths.push(entryPath);
			}
		}
	}

	const sizes = await mapConcurrent(filePaths, systemResourcesService.getIoConcurrency(), async (filePath) => {
		try {
			return (await bunFile(filePath).stat()).size;
		} catch {
			// file vanished mid-measure — count it with zero bytes
			return 0;
		}
	});

	return { bytes: sizes.reduce((total, size) => total + size, 0), files: sizes.length };
}
