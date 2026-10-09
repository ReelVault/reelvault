import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { workerJobRepository } from "@/database/repositories/worker.repository";
import { workerOperationRepository } from "@/database/repositories/worker-operation.repository";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { librariesService } from "./libraries.service";
import { libraryWatcherService } from "./watching/library-watcher.service";

const stubs: Array<{ restore(): void }> = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("health reports each path on disk, the watcher's view of it and the last finished scan", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelvault-health-"));
	tempDirs.push(root);
	const existing = join(root, "movies");
	mkdirSync(existing);
	const missing = join(root, "unmounted");

	stubs.push(
		stubMethod(librariesRepository, "findPage", () =>
			Promise.resolve({
				data: [
					{
						id: "lib-1",
						paths: [
							{ id: "p-existing", path: existing },
							{ id: "p-missing", path: missing },
						],
					},
					{ id: "lib-2", paths: [] },
				],
			}),
		),
		stubMethod(libraryWatcherService, "getUnwatchablePaths", () => [
			{
				libraryId: "lib-1",
				pathId: "p-existing",
				path: existing,
				reason: "watch_failed: EACCES: permission denied",
				since: 1_700_000_000_000,
			},
		]),
		stubMethod(workerOperationRepository, "findLatestLibraryScanTimes", () => new Map([["lib-1", new Date("2026-10-01T10:00:00.000Z")]])),
	);

	const health = await librariesService.getHealth();

	expect(health).toEqual({
		data: [
			{
				libraryId: "lib-1",
				lastScanAt: "2026-10-01T10:00:00.000Z",
				paths: [
					{
						pathId: "p-existing",
						path: existing,
						exists: true,
						isDirectory: true,
						watchStatus: "unwatchable",
						unwatchableCode: "library.watch_failed",
						unwatchableSince: new Date(1_700_000_000_000).toISOString(),
					},
					{ pathId: "p-missing", path: missing, exists: false, isDirectory: false, watchStatus: "watching" },
				],
			},
			{ libraryId: "lib-2", lastScanAt: null, paths: [] },
		],
	});
});

test("an error check reports no result while it runs and its findings once it has completed", async () => {
	const result = {
		libraryPaths: ["/media"],
		scannedFiles: 3,
		cleanFiles: 2,
		problematicFiles: [{ filePath: "/media/broken.mkv", errors: "Invalid NAL unit size" }],
	};
	const operations = [
		{ type: "library-errors-check", status: "running", progressPercent: 40 },
		{ type: "library-errors-check", status: "completed", progressPercent: 100 },
	];
	stubs.push(
		stubMethod(workerService, "getOperation", () => operations.shift()),
		stubMethod(workerJobRepository, "findByOperation", () => Promise.resolve([{ result: JSON.stringify(result) }])),
	);

	expect(await librariesService.getErrorsCheckStatus("op-1")).toEqual({
		status: "running",
		progressPercent: 40,
		result: null,
	});
	expect(await librariesService.getErrorsCheckStatus("op-1")).toEqual({
		status: "completed",
		progressPercent: 100,
		result,
	});
});

test("an operation of another type is not an error check", async () => {
	stubs.push(stubMethod(workerService, "getOperation", () => ({ type: "library-scanning", status: "completed", progressPercent: 100 })));

	await expect(librariesService.getErrorsCheckStatus("op-scan")).rejects.toMatchObject({
		code: "library.errors_check_not_found",
		category: "not_found",
	});
});
