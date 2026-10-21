import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mediaRepository } from "@/repositories/media-files.repository";
import { workerJobRepository } from "@/repositories/worker.repository";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { workerService } from "@/workers/worker.service";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { auditMediaFileTask, mediaFileAuditWorker, mediaMatchAuditScanWorker, scanMediaMatchAuditTask } from "./media-file-audit.worker";

// Audit rows come from real media rows; recognition and the audit rules run unstubbed.
const database = useTestDatabase();

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	workerService.registry.register(mediaFileAuditWorker);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
	workerService.registry.unregister(mediaFileAuditWorker.id);
});

describe("media file audit task", () => {
	test("reports a file whose name does not match its assigned title as a suspect", async () => {
		const mediaFileId = await insertMovieMediaFile(database.client(), "/media/unrelated.mkv", "zebra-documentary");

		await expect(auditMediaFileTask({ mediaFileId })).resolves.toEqual({ mediaFileId, suspect: true });
	});

	test("reports a matching file and a missing row as not suspect", async () => {
		const mediaFileId = await insertMovieMediaFile(database.client(), "/media/Movie.2020.mkv", "Movie");

		await expect(auditMediaFileTask({ mediaFileId })).resolves.toEqual({ mediaFileId, suspect: false });
		await expect(auditMediaFileTask({ mediaFileId: "missing" })).resolves.toEqual({ mediaFileId: "missing", suspect: false });
	});

	test("queues one task per audited file under the scan's operation and task", async () => {
		const operationId = "operation-1";
		const taskId = "task-1";
		await workerOperationRepository.create({ id: operationId, type: mediaMatchAuditScanWorker.id });
		await workerJobRepository.enqueue({
			id: taskId,
			workerId: mediaMatchAuditScanWorker.id,
			operationId,
			data: "{}",
			priority: 0,
			maxAttempts: 1,
			backoffType: "fixed",
			backoffDelayMs: 1_000,
			runAt: new Date(),
		});
		const mediaFileIds = [
			await insertMovieMediaFile(database.client(), "/media/a.mkv", "m-a"),
			await insertMovieMediaFile(database.client(), "/media/b.mkv", "m-b"),
			await insertMovieMediaFile(database.client(), "/media/c.mkv", "m-c"),
		];

		await expect(scanMediaMatchAuditTask({ operationId, taskId })).resolves.toEqual({ requested: 3, queued: 3 });

		const queued = (await workerJobRepository.findByOperation(operationId, 10)).filter(
			(item) => item.workerId === mediaFileAuditWorker.id && item.dependsOnJobId === taskId,
		);
		expect(
			queued.map((item) => JSON.parse(item.data).mediaFileId).toSorted((left: string, right: string) => left.localeCompare(right)),
		).toEqual(mediaFileIds.toSorted());
	});

	test("converts scan failures to domain errors", async () => {
		activeStubs.push(stubMethod(mediaRepository, "scanAuditRowIds", () => Promise.reject(new Error("database unavailable"))));

		await expect(scanMediaMatchAuditTask({})).rejects.toMatchObject({ code: "internal" });
	});
});
