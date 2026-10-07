import { sleep } from "bun";
import { toDomainError } from "@/application/context";
import { databaseFactory } from "@/database/database";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { collectKeysetPages } from "@/database/utils/keyset-pages";
import { episodeRangeSpan, parseFileName } from "@/modules/recognition/utils/recognition.utils";
import { toMap } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { PathUtils } from "@/utils/path.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { fileScannerService } from "./disk/file-scanner";
import { type RemovalGuard, removalGuard } from "./disk/removal-guard";
import { type StaleArtifactCleaner, staleArtifactCleaner } from "./processing/stale-artifact-cleaner";
import type { LibraryScanResult, LibraryType } from "./scanner.types";
import { filterPathsWithinRoots } from "./utils/scanner.utils";

/** Rows read per keyset page while diffing a library against disk. */
const SCAN_DB_PAGE_SIZE = 5000;

/**
 * One pass over the on-disk list: unknown paths are new, and a TV range file
 * that owns fewer rows than its name spans is re-ingested so the missing
 * episodes get their rows (idempotent: existing rows conflict-do-nothing). Uses
 * the same capped span as the processor, so an over-long "range" treated as
 * scene noise is never re-read.
 */
function collectNewFiles(filesOnDisk: readonly string[], type: LibraryType, pathCounts: ReadonlyMap<string, number>): string[] {
	const newFiles: string[] = [];
	for (const filePath of filesOnDisk) {
		const rowCount = pathCounts.get(filePath);
		if (rowCount === undefined) {
			newFiles.push(filePath);
			continue;
		}

		if (type !== "tv_show") continue;

		const span = episodeRangeSpan(parseFileName(PathUtils.getFileName(filePath)));
		if (span !== undefined && span > rowCount) newFiles.push(filePath);
	}

	return newFiles;
}

interface ScanStatsRow {
	id: string;
	filePath: string;
	size: number | null;
	sourceMtimeMs: number | null;
}

interface ServiceDependencies {
	findStatsPage: (libraryId: string, cursor: string | undefined, limit: number) => Promise<ScanStatsRow[]>;
	discover: (
		paths: string[],
		signal?: AbortSignal,
	) => Promise<{ filesOnDisk: string[]; statsByPath: Map<string, { size: number; mtimeMs: number }> }>;
	guard: Pick<RemovalGuard, "assess">;
	cleaner: Pick<StaleArtifactCleaner, "cleanup">;
}

const defaultDependencies: ServiceDependencies = {
	findStatsPage: (libraryId, cursor, limit) => mediaRepository.findStatsByLibraryIdPage(libraryId, cursor, limit),
	discover: async (paths, signal) => {
		const scannedEntries = await fileScannerService.scanWithStats({ paths, signal });

		return { filesOnDisk: scannedEntries.map((entry) => entry.filePath), statsByPath: toMap(scannedEntries, (entry) => entry.filePath) };
	},
	guard: removalGuard,
	cleaner: staleArtifactCleaner,
};

export class ScannerService extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("ScannerService");
		this.dependencies = dependencies;
	}

	/**
	 * Keyset-pages the DB rows so a large library never blocks the event loop in
	 * one query; yields between pages. Only the on-disk side needs a map.
	 */
	private async collectDatabaseStats(
		libraryId: string,
		statsByPath: ReadonlyMap<string, { size: number; mtimeMs: number }>,
		signal?: AbortSignal,
	): Promise<{
		pathCounts: Map<string, number>;
		removedAll: string[];
		changedFiles: string[];
		existingCount: number;
	}> {
		const pathCounts = new Map<string, number>();
		const removedAll: string[] = [];
		const changedFiles: string[] = [];
		let existingCount = 0;
		await collectKeysetPages({
			pageSize: SCAN_DB_PAGE_SIZE,
			beforePage: () => throwIfAborted(signal),
			fetchPage: (cursor) => this.dependencies.findStatsPage(libraryId, cursor, SCAN_DB_PAGE_SIZE),
			onPage: (rows) => {
				for (const row of rows) {
					existingCount++;
					pathCounts.set(row.filePath, (pathCounts.get(row.filePath) ?? 0) + 1);
					const diskStat = statsByPath.get(row.filePath);
					if (!diskStat) {
						removedAll.push(row.filePath);
						continue;
					}

					if (row.size !== diskStat.size || row.sourceMtimeMs !== diskStat.mtimeMs) changedFiles.push(row.id);
				}
			},
			betweenPages: () => sleep(0),
		});

		return { pathCounts, removedAll, changedFiles, existingCount };
	}

	async scanPaths(libraryId: string, type: LibraryType, paths?: string[], signal?: AbortSignal): Promise<LibraryScanResult> {
		return await this.safeExecute(
			"scanPaths",
			async () => {
				throwIfAborted(signal);
				const scanStartedAt = performance.now();
				const effectivePaths = paths ?? [];

				this.logger.info("Library scan started", { libraryId, type, pathCount: effectivePaths.length });
				if (effectivePaths.length === 0) {
					this.logger.warn("No paths provided for scanning");

					return { filePaths: [], newFilePaths: [], changedMediaFileIds: [] };
				}

				const { filesOnDisk, statsByPath } = await this.dependencies.discover(effectivePaths, signal);
				const { pathCounts, removedAll, changedFiles, existingCount } = await this.collectDatabaseStats(libraryId, statsByPath, signal);

				const newFiles = collectNewFiles(filesOnDisk, type, pathCounts);

				const removedCandidates = filterPathsWithinRoots(removedAll, effectivePaths);
				throwIfAborted(signal);

				const { removedFiles, storageUnavailable, massRemoval, skipRemovals } = await this.dependencies.guard.assess({
					libraryId,
					candidates: removedCandidates,
					roots: effectivePaths,
					existingCount,
					filesOnDiskCount: filesOnDisk.length,
					signal,
				});

				if (massRemoval) {
					this.logger.error(
						"Refusing to remove library records — the scan found drastically fewer files than the database. Likely a transient storage failure.",
						{ libraryId, existingRecords: existingCount, filesOnDisk: filesOnDisk.length, removalCandidates: removedFiles.length },
					);
				}

				if (storageUnavailable) {
					this.logger.error("Refusing to remove library records — some paths could not be stat'ed (storage unavailable / permissions).", {
						libraryId,
						removalCandidates: removedFiles.length,
					});
				}

				this.logger.debug("Database comparison completed", {
					libraryId,
					newFiles: newFiles.length,
					removedFiles: removedFiles.length,
					massRemoval,
					storageUnavailable,
					changedFiles: changedFiles.length,
					durationMs: Math.round(performance.now() - scanStartedAt),
				});

				if (removedFiles.length > 0 && !skipRemovals) {
					await this.dependencies.cleaner.cleanup(libraryId, removedFiles, signal);
				}

				this.logger.info("Library scan processing completed", {
					libraryId,
					discoveredFiles: filesOnDisk.length,
					newFiles: newFiles.length,
					changedFiles: changedFiles.length,
					durationMs: Math.round(performance.now() - scanStartedAt),
				});

				// A scan can add/remove many rows; refresh planner statistics so the
				// paginated browse path keeps using the composite indexes.
				databaseFactory.analyze();

				return { filePaths: filesOnDisk, newFilePaths: newFiles, changedMediaFileIds: changedFiles };
			},
			{
				customThrow: (error) => toDomainError(error, `Library scan failed: ${libraryId}`),
				logContext: { libraryId, type },
			},
		);
	}
}

export const scannerService = new ScannerService();
