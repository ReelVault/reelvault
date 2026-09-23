import { describe, expect, test } from "bun:test";
import type { RemovalAssessment } from "./disk/removal-guard";
import { ScannerService } from "./scanner.service";

interface DepsOverrides {
	diskFiles?: string[];
	dbRows?: Array<{ id: string; filePath: string; size: number; sourceMtimeMs: number }>;
	assessment?: Partial<RemovalAssessment>;
}

function createService(overrides: DepsOverrides = {}) {
	const diskFiles = overrides.diskFiles ?? [];
	const dbRows = overrides.dbRows ?? [];
	const cleanupCalls: string[][] = [];
	const service = new ScannerService({
		findStatsPage: (libraryId: string, cursor: string | undefined, limit: number) => {
			expect(libraryId).toBe("lib-1");
			const start = cursor ? dbRows.findIndex((row) => row.id === cursor) + 1 : 0;

			return Promise.resolve(dbRows.slice(start, start + limit));
		},
		discover: () =>
			Promise.resolve({
				filesOnDisk: diskFiles,
				statsByPath: new Map(diskFiles.map((filePath) => [filePath, { size: 100, mtimeMs: 500 }])),
			}),
		guard: {
			assess: ({ candidates }: { candidates: string[] }) =>
				Promise.resolve({
					removedFiles: candidates,
					storageUnavailable: false,
					massRemoval: false,
					skipRemovals: false,
					...overrides.assessment,
				}),
		},
		cleaner: {
			cleanup: (_libraryId: string, removedFiles: string[]) => {
				cleanupCalls.push(removedFiles);

				return Promise.resolve();
			},
		},
	});

	return { service, cleanupCalls };
}

const SCAN_ROOT = "/media/library";

describe("ScannerService.scanPaths", () => {
	test("returns empty results without discovering anything when no paths are given", async () => {
		const { service, cleanupCalls } = createService({
			dbRows: [{ id: "row-1", filePath: "/media/library/a.mkv", size: 100, sourceMtimeMs: 500 }],
		});

		const result = await service.scanPaths("lib-1", "movie", []);

		expect(result).toEqual({ filePaths: [], newFilePaths: [], changedMediaFileIds: [] });
		expect(cleanupCalls).toEqual([]);
	});

	test("reports new, unchanged and removed files from the diff", async () => {
		const { service } = createService({
			diskFiles: [`${SCAN_ROOT}/a.mkv`, `${SCAN_ROOT}/b.mkv`],
			dbRows: [
				{ id: "row-b", filePath: `${SCAN_ROOT}/b.mkv`, size: 100, sourceMtimeMs: 500 },
				{ id: "row-c", filePath: "/elsewhere/outside.mkv", size: 100, sourceMtimeMs: 500 },
			],
		});

		const result = await service.scanPaths("lib-1", "movie", [SCAN_ROOT]);

		expect(result.filePaths).toEqual([`${SCAN_ROOT}/a.mkv`, `${SCAN_ROOT}/b.mkv`]);
		expect(result.newFilePaths).toEqual([`${SCAN_ROOT}/a.mkv`]);
		// row-c is outside the scan roots — filtered before the removal guard.
		expect(result.changedMediaFileIds).toEqual([]);
	});

	test("flags changed files when size or mtime drift from the database", async () => {
		const { service } = createService({
			diskFiles: [`${SCAN_ROOT}/a.mkv`],
			dbRows: [{ id: "row-a", filePath: `${SCAN_ROOT}/a.mkv`, size: 999, sourceMtimeMs: 500 }],
		});

		const result = await service.scanPaths("lib-1", "movie", [SCAN_ROOT]);

		expect(result.changedMediaFileIds).toEqual(["row-a"]);
	});

	test("cleans up removed files when the guard allows removals", async () => {
		const { service, cleanupCalls } = createService({
			diskFiles: [],
			dbRows: [{ id: "row-a", filePath: `${SCAN_ROOT}/a.mkv`, size: 100, sourceMtimeMs: 500 }],
		});

		await service.scanPaths("lib-1", "movie", [SCAN_ROOT]);

		expect(cleanupCalls).toEqual([[`${SCAN_ROOT}/a.mkv`]]);
	});

	test("skips cleanup when the guard refuses removals", async () => {
		const { service, cleanupCalls } = createService({
			diskFiles: [],
			dbRows: [{ id: "row-a", filePath: `${SCAN_ROOT}/a.mkv`, size: 100, sourceMtimeMs: 500 }],
			assessment: { skipRemovals: true },
		});

		await service.scanPaths("lib-1", "movie", [SCAN_ROOT]);

		expect(cleanupCalls).toEqual([]);
	});
});
