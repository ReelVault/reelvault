import { afterEach, describe, expect, test } from "bun:test";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { insertMetadata, selectMetadata } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { metadataService } from "./metadata/metadata.service";

// Titles, movies and media files are real rows. The only stub is the in-process stream registry,
// which is what a player would hold open.
const db = useTestDatabase();
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

/** Title "m1" with one media file that a stream can be playing; title "m2" has no file. */
async function seedTitles(): Promise<string> {
	const streamedFileId = await insertMovieMediaFile(db.client(), "/movies/m1.mkv", "m1");
	await insertMetadata(db.client(), { id: "m2", stableKey: "m2", title: "Title two", type: "movie", releaseDate: "2020-01-01" });

	return streamedFileId;
}

async function remainingTitleIds(): Promise<string[]> {
	const rows = await selectMetadata(db.client());

	return rows.map((row) => row.id).toSorted();
}

describe("metadataService.deleteMany while streams are active", () => {
	test("holds a bulk title delete back while a stream plays one of the title's files", async () => {
		const streamedFileId = await seedTitles();
		stubs.push(stubMethod(streamingManager, "getActiveMediaFileIds", () => new Set([streamedFileId])));

		await expect(metadataService.deleteMany(["m1"])).rejects.toMatchObject({
			code: "metadata.delete_blocked_active_streams",
			params: { activeStreams: 1 },
		});
		expect(await remainingTitleIds()).toEqual(["m1", "m2"]);
	});

	test("deletes the titles once the admin forces it, and reports each title's outcome", async () => {
		const streamedFileId = await seedTitles();
		stubs.push(stubMethod(streamingManager, "getActiveMediaFileIds", () => new Set([streamedFileId])));

		const outcome = await metadataService.deleteMany(["m1", "m2"], { force: true });

		expect(outcome).toEqual({
			results: [
				{ id: "m1", ok: true },
				{ id: "m2", ok: true },
			],
		});
		expect(await remainingTitleIds()).toEqual([]);
	});

	test("a stream on some other title's file does not hold the delete back", async () => {
		await seedTitles();
		stubs.push(stubMethod(streamingManager, "getActiveMediaFileIds", () => new Set(["unrelated-file"])));

		expect(await metadataService.deleteMany(["m2"])).toEqual({ results: [{ id: "m2", ok: true }] });
		expect(await remainingTitleIds()).toEqual(["m1"]);
	});

	test("deletes titles without a force flag when no stream plays their files", async () => {
		await seedTitles();
		stubs.push(stubMethod(streamingManager, "getActiveMediaFileIds", () => new Set()));

		const outcome = await metadataService.deleteMany(["m2"]);

		expect(outcome).toEqual({ results: [{ id: "m2", ok: true }] });
		expect(await remainingTitleIds()).toEqual(["m1"]);
	});
});
