import { afterEach, describe, expect, test } from "bun:test";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { selectMediaFiles } from "../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { mediaService } from "./media-files.service";

// Media files are real rows. The only stub is the in-process stream registry.
const db = useTestDatabase();
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

async function seedFiles(): Promise<void> {
	await insertMovieMediaFile(db.client(), "/movies/f1.mkv", "m-f1");
	await insertMovieMediaFile(db.client(), "/movies/f2.mkv", "m-f2");
}

async function remainingFileIds(): Promise<string[]> {
	const rows = await selectMediaFiles(db.client());

	return rows.map((row) => row.id).toSorted();
}

async function fileIdByName(fileName: string): Promise<string> {
	const row = (await selectMediaFiles(db.client())).find((item) => item.fileName === fileName);

	return row?.id ?? "";
}

describe("mediaService.deleteMany while streams are active", () => {
	test("holds a bulk delete back while a stream plays one of the files, and deletes nothing", async () => {
		await seedFiles();
		const streamed = await fileIdByName("f1.mkv");
		stubs.push(stubMethod(streamingManager, "getAllActiveSessions", () => [{ mediaFileId: streamed }]));

		await expect(mediaService.deleteMany([streamed, await fileIdByName("f2.mkv")])).rejects.toMatchObject({
			code: "media.delete_blocked_active_streams",
			params: { activeStreams: 1 },
		});
		expect(await remainingFileIds()).toHaveLength(2);
	});

	test("a stream on a file outside the batch does not hold the delete back", async () => {
		await seedFiles();
		stubs.push(stubMethod(streamingManager, "getAllActiveSessions", () => [{ mediaFileId: "unrelated-file" }]));
		const other = await fileIdByName("f2.mkv");

		expect(await mediaService.deleteMany([other])).toEqual({ results: [{ id: other, ok: true }] });
		expect(await remainingFileIds()).toHaveLength(1);
	});

	test("deletes the files once the admin forces it, and reports a failure by its code", async () => {
		await seedFiles();
		const streamed = await fileIdByName("f1.mkv");
		const other = await fileIdByName("f2.mkv");
		stubs.push(stubMethod(streamingManager, "getAllActiveSessions", () => [{ mediaFileId: streamed }]));

		const outcome = await mediaService.deleteMany([streamed, "missing-file", other, streamed], { force: true });

		expect(outcome).toEqual({
			results: [
				{ id: streamed, ok: true },
				{ id: "missing-file", ok: false, code: "entity.not_found" },
				{ id: other, ok: true },
			],
		});
		expect(await remainingFileIds()).toEqual([]);
	});
});
