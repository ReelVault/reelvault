import { afterEach, describe, expect, test } from "bun:test";
import { mediaService } from "@/application/media/media-files/media-files.service";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/database/repositories/media-markers.repository";
import { stubMethod } from "../../../../tests/helpers/method-stub";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0).toReversed()) stub.restore();
});

const NDJSON = [
	JSON.stringify({ mediaFileId: "file-a", type: "intro", startSeconds: 0, endSeconds: 30 }),
	JSON.stringify({ mediaFileId: "file-b", type: "recap", startSeconds: 5, endSeconds: 9 }),
	JSON.stringify({ mediaFileId: "file-a", type: "credits", startSeconds: 2000, endSeconds: 2100 }),
].join("\n");

describe("MediaService marker import", () => {
	test("replaces each named file's markers once and reports the counts", async () => {
		const existence = stubMethod(mediaRepository, "isExists", () => Promise.resolve(true));
		const replace = stubMethod(mediaMarkersRepository, "replaceMarkersForMediaFile", (mediaFileId: string, markers: unknown[]) =>
			Promise.resolve(
				markers.map((_, index) => ({
					id: `${mediaFileId}-${index}`,
					mediaFileId,
					type: "intro",
					startSeconds: 0,
					endSeconds: 1,
					label: null,
					source: "manual",
					pluginId: null,
					createdAt: new Date(),
					updatedAt: new Date(),
				})),
			),
		);
		const before = stubMethod(mediaMarkersRepository, "findByMediaFileId", () => Promise.resolve([]));
		activeStubs.push(existence, replace, before);

		const result = await mediaService.importMarkers(NDJSON);

		expect(result).toEqual({ mediaFiles: 2, markers: 3 });
		expect(replace.calls.map((call) => call[0])).toEqual(["file-a", "file-b"]);
		expect(replace.calls[0]?.[1]).toHaveLength(2);
	});

	test("refuses the whole import when a named file does not exist, before any marker is written", async () => {
		const existence = stubMethod(mediaRepository, "isExists", (query: { primaryId: string }) =>
			Promise.resolve(query.primaryId !== "file-b"),
		);
		const replace = stubMethod(mediaMarkersRepository, "replaceMarkersForMediaFile", () => Promise.resolve([]));
		activeStubs.push(existence, replace);

		await expect(mediaService.importMarkers(NDJSON)).rejects.toMatchObject({
			code: "media.markers_import_unknown_file",
			params: { mediaFileId: "file-b" },
		});
		expect(replace.calls).toHaveLength(0);
	});

	test("refuses an invalid line before looking at any media file", async () => {
		const existence = stubMethod(mediaRepository, "isExists", () => Promise.resolve(true));
		activeStubs.push(existence);

		await expect(
			mediaService.importMarkers(`${NDJSON}\n{"mediaFileId":"file-a","type":"intro","startSeconds":9,"endSeconds":1}`),
		).rejects.toMatchObject({
			code: "media.markers_import_invalid",
			params: { line: 4, reason: "end_before_start" },
		});
		expect(existence.calls).toHaveLength(0);
	});
});
