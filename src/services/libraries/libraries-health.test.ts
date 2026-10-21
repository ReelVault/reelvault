import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeSync } from "@/utils/directory.utils";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import {
	insertLibraries,
	insertLibraryPaths,
	insertWorkerJobs,
	insertWorkerOperations,
	updateWorkerOperation,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { librariesService } from "./libraries.service";
import { libraryWatcherService } from "./watching/library-watcher.service";

const { client } = useTestDatabase();

const stubs: Array<{ restore(): void }> = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	for (const dir of tempDirs.splice(0)) removeTreeSync(dir);
});

describe("library health", () => {
	test("health reports each path on disk, the watcher's view of it and the last finished scan", async () => {
		const root = mkdtempSync(join(tmpdir(), "reelvault-health-"));
		tempDirs.push(root);
		const existing = join(root, "movies");
		mkdirSync(existing);
		const missing = join(root, "unmounted");

		await insertLibraries(client(), [
			{ id: "lib-1", name: "Movies", type: "movies" },
			{ id: "lib-2", name: "Archive", type: "movies" },
		]);
		await insertLibraryPaths(client(), [
			{ id: "p-existing", libraryId: "lib-1", stableKey: "lib-1:existing", path: existing },
			{ id: "p-missing", libraryId: "lib-1", stableKey: "lib-1:missing", path: missing },
		]);
		await insertWorkerOperations(client(), {
			id: "scan-old",
			type: "library-scanning",
			referenceType: "library",
			referenceId: "lib-1",
			status: "completed",
			createdAt: new Date("2026-10-01T10:00:00.000Z"),
		});

		// The watcher's failure state comes from the OS (EACCES here), so the watcher stands in for it.
		stubs.push(
			stubMethod(libraryWatcherService, "getUnwatchablePaths", () => [
				{
					libraryId: "lib-1",
					pathId: "p-existing",
					path: existing,
					reason: "watch_failed: EACCES: permission denied",
					since: 1_700_000_000_000,
				},
			]),
		);

		const health = await librariesService.getHealth();

		expect(health.data).toHaveLength(2);
		expect(health.data).toContainEqual({
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
		});
		expect(health.data).toContainEqual({ libraryId: "lib-2", lastScanAt: null, paths: [] });
	});

	test("an error check reports no result while it runs and its findings once it has completed", async () => {
		const result = {
			libraryPaths: ["/media"],
			scannedFiles: 3,
			cleanFiles: 2,
			problematicFiles: [{ filePath: "/media/broken.mkv", errors: "Invalid NAL unit size" }],
		};
		await insertWorkerOperations(client(), { id: "op-1", type: "library-errors-check", status: "running", progressPercent: 40 });
		// The job already carries a result, so only the operation's status keeps it hidden while the check runs.
		await insertWorkerJobs(client(), {
			id: "job-1",
			workerId: "library-errors-check",
			operationId: "op-1",
			data: "{}",
			status: "completed",
			runAt: new Date(),
			result: JSON.stringify(result),
		});

		expect(await librariesService.getErrorsCheckStatus("op-1")).toEqual({
			status: "running",
			progressPercent: 40,
			result: null,
		});

		await updateWorkerOperation(client(), "op-1", { status: "completed", progressPercent: 100 });

		expect(await librariesService.getErrorsCheckStatus("op-1")).toEqual({
			status: "completed",
			progressPercent: 100,
			result,
		});
	});
});
