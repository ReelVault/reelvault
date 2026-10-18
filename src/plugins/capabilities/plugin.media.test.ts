import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginMediaService } from "./plugin.media";

const db = useTestDatabase();

/** A movie file whose row carries the given duration (seconds) and stays null when none is given. */
async function seedMovieFile(duration: number | null): Promise<string> {
	const client = db.client();
	const mediaFileId = await insertMovieMediaFile(client, "/media/movie.mkv", "meta-1");
	if (duration !== null) await client.update(schema.mediaFiles).set({ duration }).where(eq(schema.mediaFiles.id, mediaFileId));

	return mediaFileId;
}

describe("pluginMediaService.get", () => {
	test("maps duration seconds to durationMs and marks the file available", async () => {
		const mediaFileId = await seedMovieFile(42.5);

		const result = await pluginMediaService.get(mediaFileId);

		expect(result).toEqual({
			id: mediaFileId,
			metadataId: "meta-1",
			fileName: "movie.mkv",
			filePath: "/media/movie.mkv",
			durationMs: 42_500,
			available: true,
		});
	});

	test("omits durationMs when duration is unknown", async () => {
		const mediaFileId = await seedMovieFile(null);

		const result = await pluginMediaService.get(mediaFileId);

		expect(result?.available).toBe(true);
		expect(result?.durationMs).toBeUndefined();
	});

	test("returns null for an unknown media file", async () => {
		await expect(pluginMediaService.get("missing")).resolves.toBeNull();
	});
});

describe("pluginMediaService.getRevision", () => {
	test("projects size, mtime and the audio streams in index order", async () => {
		const client = db.client();
		const mediaFileId = await seedMovieFile(null);
		await client
			.update(schema.mediaFiles)
			.set({ size: 2048, sourceMtimeMs: 1_700_000_000_000 })
			.where(eq(schema.mediaFiles.id, mediaFileId));
		await client.insert(schema.mediaFileAudioStreams).values([
			{ mediaFileId, index: 1, isDefault: false, codecName: "ac3", channels: 2, language: "eng" },
			{ mediaFileId, index: 0, isDefault: true, codecName: "aac", channels: 6, language: "pol" },
		]);

		const revision = await pluginMediaService.getRevision(mediaFileId);

		expect(revision).toEqual({
			size: 2048,
			sourceMtimeMs: 1_700_000_000_000,
			audioStreams: [
				{ index: 0, channels: 6, isDefault: true },
				{ index: 1, channels: 2, isDefault: false },
			],
		});
	});

	test("returns null when the media file is unknown", async () => {
		await expect(pluginMediaService.getRevision("missing")).resolves.toBeNull();
	});
});
