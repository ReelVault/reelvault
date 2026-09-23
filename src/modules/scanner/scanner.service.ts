import { sleep } from "bun";
import { toDomainError } from "@/application/context";
import { databaseFactory } from "@/database/database";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { toMap } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { fileScannerService } from "./disk/file-scanner";
import { type RemovalGuard, removalGuard } from "./disk/removal-guard";
import { type StaleArtifactCleaner, staleArtifactCleaner } from "./processing/stale-artifact-cleaner";
import type { LibraryScanResult, LibraryType } from "./scanner.types";
import { filterPathsWithinRoots } from "./utils/scanner.utils";

/** Rows read per keyset page while diffing a library against disk. */
const SCAN_DB_PAGE_SIZE = 5000;

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
				// Keyset-page the DB rows so a large library never blocks the event loop
				// in one query; yield between pages. Only the on-disk side needs a map.
				const existingPaths = new Set<string>();
				const removedAll: string[] = [];
				const changedFiles: string[] = [];
				let existingCount = 0;
				let cursor: string | undefined;
				for (;;) {
					throwIfAborted(signal);
					const rows = await this.dependencies.findStatsPage(libraryId, cursor, SCAN_DB_PAGE_SIZE);
					if (rows.length === 0) break;

					for (const row of rows) {
						existingCount++;
						existingPaths.add(row.filePath);
						const diskStat = statsByPath.get(row.filePath);
						if (!diskStat) {
							removedAll.push(row.filePath);
							continue;
						}

						if (row.size !== diskStat.size || row.sourceMtimeMs !== diskStat.mtimeMs) changedFiles.push(row.id);
					}

					if (rows.length < SCAN_DB_PAGE_SIZE) break;

					cursor = rows.at(-1)?.id;
					if (!cursor) break;

					await sleep(0);
				}

				const newFiles = filesOnDisk.filter((filePath) => !existingPaths.has(filePath));
				const removedCandidates = filterPathsWithinRoots(removedAll, effectivePaths);
				throwIfAborted(signal);

				const { removedFiles, storageUnavailable, massRemoval, skipRemovals } = await this.dependencies.guard.assess({
					libraryId,
					candidates: removedCandidates,
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
