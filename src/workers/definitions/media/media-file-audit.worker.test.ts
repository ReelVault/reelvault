import { afterEach, describe, expect, test } from "bun:test";
import type { MediaFileAuditRow } from "@/database/repositories/media-files.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { recognitionService } from "@/modules/recognition/recognition.service";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { auditMediaFileTask, scanMediaMatchAuditTask } from "./media-file-audit.worker";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

function createMockAuditRow(overrides: Partial<MediaFileAuditRow> = {}): MediaFileAuditRow {
	return {
		mediaFileId: "file-1",
		fileName: "movie.mkv",
		filePath: "/media/movie.mkv",
		libraryId: "lib-1",
		libraryName: "Movies",
		libraryType: "movie",
		metadataId: "meta-1",
		metadataTitle: "Movie",
		metadataOriginalTitle: null,
		metadataReleaseDate: "2024-01-01",
		metadataMatchScore: 1,
		metadataType: "movie",
		episodeNumber: null,
		seasonNumber: null,
		...overrides,
	};
}

describe("media file audit task", () => {
	test("reports whether a single file is a suspect", async () => {
		activeStubs.push(
			stubMethod(recognitionService, "recognize", () => null),
			stubMethod(mediaRepository, "findAuditRow", () =>
				Promise.resolve(
					createMockAuditRow({
						mediaFileId: "file-1",
						fileName: "unrelated.mkv",
						filePath: "/media/unrelated.mkv",
						metadataTitle: "Zebra Documentary",
					}),
				),
			),
		);

		const result = await auditMediaFileTask({ mediaFileId: "file-1" });

		expect(result).toEqual({ mediaFileId: "file-1", suspect: true });
	});

	test("reports non-suspect for clean files and missing rows", async () => {
		activeStubs.push(stubMethod(recognitionService, "recognize", () => null));
		const findAuditRow = stubMethod(mediaRepository, "findAuditRow", () =>
			Promise.resolve(createMockAuditRow({ fileName: "Movie.2024.mkv", filePath: "/media/Movie.2024.mkv" })),
		);

		const clean = await auditMediaFileTask({ mediaFileId: "file-1" });
		expect(clean).toEqual({ mediaFileId: "file-1", suspect: false });

		findAuditRow.restore();
		activeStubs.push(stubMethod(mediaRepository, "findAuditRow", () => Promise.resolve(undefined)));

		const missing = await auditMediaFileTask({ mediaFileId: "gone" });
		expect(missing).toEqual({ mediaFileId: "gone", suspect: false });
	});

	test("requires a mediaFileId", async () => {
		await expect(auditMediaFileTask({ mediaFileId: "" })).rejects.toMatchObject({ code: "internal" });
	});

	test("queues one task per audited file with parent operation", async () => {
		const queued: Array<{ mediaFileId: string; operationId?: string | undefined; dependsOnTaskIds?: string[] | undefined }> = [];
		activeStubs.push(
			stubMethod(mediaRepository, "scanAuditRowIds", async (onPage: (ids: string[]) => Promise<void> | void) => {
				await onPage(["file-1", "file-2", "file-3"]);

				return 3;
			}),
			stubMethod(
				workerService,
				"addItems",
				(
					_workerId: string,
					entries: Array<{ data: { mediaFileId: string }; options?: { operationId?: string; dependsOnTaskIds?: string[] } }>,
				) => {
					for (const entry of entries) {
						queued.push({
							mediaFileId: entry.data.mediaFileId,
							operationId: entry.options?.operationId,
							dependsOnTaskIds: entry.options?.dependsOnTaskIds,
						});
					}

					return Promise.resolve([]);
				},
			),
		);

		const result = await scanMediaMatchAuditTask({ operationId: "operation-1", taskId: "task-1" });

		expect(result).toEqual({ requested: 3, queued: 3 });
		expect(queued.map((item) => item.mediaFileId)).toEqual(["file-1", "file-2", "file-3"]);
		for (const item of queued) {
			expect(item.operationId).toBe("operation-1");
			expect(item.dependsOnTaskIds).toEqual(["task-1"]);
		}
	});

	test("converts scan failures to domain errors", async () => {
		activeStubs.push(stubMethod(mediaRepository, "scanAuditRowIds", () => Promise.reject(new Error("database unavailable"))));

		await expect(scanMediaMatchAuditTask({})).rejects.toMatchObject({ code: "internal" });
	});
});
