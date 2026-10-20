import type { Logger } from "@reelvault/sdk/common";
import { file as bunFile } from "bun";
import { type DirectoryEntry, readDirectoryEntries } from "@/utils/directory.utils";
import { errorMessage } from "@/utils/domain.errors";
import { joinPath } from "@/utils/path.utils";
import { mapConcurrent } from "@/utils/promise.utils";

export interface LogFileStats {
	size: number;
	mtime: Date;
}

/**
 * Walks the logs tree and reports every `.log` file. `onDirectory` runs after a
 * directory's children, which is where the purge removes empty folders. The
 * walker owns the unreadable-directory policy so list and purge cannot drift.
 */
export async function walkLogFiles(
	directory: string,
	{
		logger,
		signal,
		concurrency = 1,
		onFile,
		onDirectory,
	}: {
		logger: Logger;
		signal?: AbortSignal | undefined;
		concurrency?: number | undefined;
		onFile: (filePath: string, stats: LogFileStats) => Promise<void> | void;
		onDirectory?: ((directoryPath: string) => Promise<void>) | undefined;
	},
): Promise<void> {
	let entries: DirectoryEntry[];
	try {
		entries = await readDirectoryEntries(directory);
	} catch (error) {
		logger.error("Error scanning log directory", { path: directory, error: errorMessage(error) });

		return;
	}

	await mapConcurrent(
		entries,
		concurrency,
		async (entry) => {
			signal?.throwIfAborted();
			const fullPath = joinPath(directory, entry.name);

			if (entry.isDirectory) {
				await walkLogFiles(fullPath, { logger, signal, concurrency, onFile, onDirectory });
				await onDirectory?.(fullPath);

				return;
			}

			if (!(entry.isFile && entry.name.endsWith(".log"))) return;

			const stats = await bunFile(fullPath)
				.stat()
				.catch(() => null);
			if (stats) await onFile(fullPath, stats);
		},
		signal,
	);
}
