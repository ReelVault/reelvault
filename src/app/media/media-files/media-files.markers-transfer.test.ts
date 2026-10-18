import { describe, expect, test } from "bun:test";
import { mediaService } from "@/app/media/media-files/media-files.service";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { insertMediaMarkers, selectMediaMarkers } from "../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";

// Media files and their markers are real rows; the import is read back from the marker table.
const db = useTestDatabase();

async function seedTwoFiles(): Promise<{ fileA: string; fileB: string }> {
	const fileA = await insertMovieMediaFile(db.client(), "/movies/a.mkv", "m-a");
	const fileB = await insertMovieMediaFile(db.client(), "/movies/b.mkv", "m-b");

	return { fileA, fileB };
}

function ndjson(fileA: string, fileB: string): string {
	return [
		JSON.stringify({ mediaFileId: fileA, type: "intro", startSeconds: 0, endSeconds: 30 }),
		JSON.stringify({ mediaFileId: fileB, type: "recap", startSeconds: 5, endSeconds: 9 }),
		JSON.stringify({ mediaFileId: fileA, type: "credits", startSeconds: 2000, endSeconds: 2100 }),
	].join("\n");
}

async function markersOf(mediaFileId: string): Promise<Array<[string, number, number]>> {
	const rows = await selectMediaMarkers(db.client());

	return rows
		.filter((row) => row.mediaFileId === mediaFileId)
		.map((row) => [row.type, row.startSeconds, row.endSeconds] as [string, number, number])
		.toSorted((a, b) => a[1] - b[1]);
}

describe("MediaService marker import", () => {
	test("replaces each named file's markers and reports the counts", async () => {
		const { fileA, fileB } = await seedTwoFiles();
		await insertMediaMarkers(db.client(), {
			id: "old-marker",
			mediaFileId: fileA,
			type: "recap",
			startSeconds: 1,
			endSeconds: 2,
			source: "manual",
		});

		expect(await mediaService.importMarkers(ndjson(fileA, fileB))).toEqual({ mediaFiles: 2, markers: 3 });

		expect(await markersOf(fileA)).toEqual([
			["intro", 0, 30],
			["credits", 2000, 2100],
		]);
		expect(await markersOf(fileB)).toEqual([["recap", 5, 9]]);
	});

	test("refuses the whole import when a named file does not exist, and writes no marker", async () => {
		const { fileA } = await seedTwoFiles();

		await expect(mediaService.importMarkers(ndjson(fileA, "file-missing"))).rejects.toMatchObject({
			code: "media.markers_import_unknown_file",
			params: { mediaFileId: "file-missing" },
		});

		expect(await markersOf(fileA)).toEqual([]);
	});
});
