import { describe, expect, test } from "bun:test";
import type { MediaFileAuditItem } from "@sdk/common/media-file.types";
import type { MediaFileAuditRow } from "@/database/repositories/media-files.repository";
import { auditMediaFileTask, type MediaFileAuditTaskDependencies, scanMediaMatchAuditTask } from "./media-file-audit.worker";

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

function createMockAuditItem(overrides: Partial<MediaFileAuditItem> = {}): MediaFileAuditItem {
	return {
		mediaFileId: "file-1",
		fileName: "movie.mkv",
		filePath: "/media/movie.mkv",
		libraryId: "lib-1",
		mediaType: "movie",
		currentMetadata: {
			id: "meta-1",
			title: "Movie",
		},
		recognized: {
			title: "Movie",
		},
		similarityScore: 0.2,
		reasons: [],
		...overrides,
	};
}

function dependencies(overrides: Partial<MediaFileAuditTaskDependencies> = {}): MediaFileAuditTaskDependencies {
	return {
		findAuditRow: async (mediaFileId) => createMockAuditRow({ mediaFileId }),
		findAllAuditRowIds: async () => ["file-1", "file-2"],
		auditRow: () => null,
		enqueue: async () => undefined,
		...overrides,
	};
}

describe("media file audit task", () => {
	test("reports whether a single file is a suspect", async () => {
		const result = await auditMediaFileTask(
			{ mediaFileId: "file-1" },
			{},
			dependencies({
				auditRow: () => createMockAuditItem({ mediaFileId: "file-1", similarityScore: 0.2, reasons: [] }),
			}),
		);

		expect(result).toEqual({ mediaFileId: "file-1", suspect: true });
	});

	test("reports non-suspect for clean files and missing rows", async () => {
		const clean = await auditMediaFileTask({ mediaFileId: "file-1" }, {}, dependencies());
		expect(clean).toEqual({ mediaFileId: "file-1", suspect: false });

		const missing = await auditMediaFileTask({ mediaFileId: "gone" }, {}, dependencies({ findAuditRow: async () => undefined }));
		expect(missing).toEqual({ mediaFileId: "gone", suspect: false });
	});

	test("requires a mediaFileId", async () => {
		await expect(auditMediaFileTask({ mediaFileId: "" }, {}, dependencies())).rejects.toMatchObject({ code: "internal" });
	});

	test("queues one task per audited file with parent operation", async () => {
		const queued: Array<{ mediaFileId: string; operationId?: string | undefined; dependsOnTaskIds?: string[] | undefined }> = [];
		const result = await scanMediaMatchAuditTask(
			{ operationId: "operation-1", taskId: "task-1" },
			dependencies({
				findAllAuditRowIds: async () => ["file-1", "file-2", "file-3"],
				enqueue: (data, options) => {
					queued.push({ mediaFileId: data.mediaFileId, operationId: options.operationId, dependsOnTaskIds: options.dependsOnTaskIds });

					return Promise.resolve(undefined);
				},
			}),
		);

		expect(result).toEqual({ requested: 3, queued: 3 });
		expect(queued.map((item) => item.mediaFileId)).toEqual(["file-1", "file-2", "file-3"]);
		for (const item of queued) {
			expect(item.operationId).toBe("operation-1");
			expect(item.dependsOnTaskIds).toEqual(["task-1"]);
		}
	});

	test("converts scan failures to domain errors", async () => {
		await expect(
			scanMediaMatchAuditTask(
				{},
				dependencies({
					findAllAuditRowIds: () => Promise.reject(new Error("database unavailable")),
				}),
			),
		).rejects.toMatchObject({ code: "internal" });
	});
});
