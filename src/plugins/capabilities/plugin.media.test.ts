import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { insertMovieMediaFile, insertSeriesEpisode } from "../../../tests/helpers/media.fixture";
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

describe("pluginMediaService.listAllMediaFiles", () => {
	test("reports the media type from the owning row", async () => {
		const client = db.client();
		const movieFileId = await insertMovieMediaFile(client, "/media/movie.mkv", "meta-movie");
		const episode = await insertSeriesEpisode(client, null);
		const [episodeFile] = await client
			.select({ id: schema.mediaFiles.id })
			.from(schema.mediaFiles)
			.where(eq(schema.mediaFiles.episodeId, episode.episodeId));
		if (!episodeFile) throw new Error("Expected the series fixture to insert an episode file");

		const files = await pluginMediaService.listAllMediaFiles();
		const mediaTypeById = new Map(files.map((file) => [file.mediaFileId, file.mediaType]));

		expect(mediaTypeById.get(movieFileId)).toBe("movie");
		expect(mediaTypeById.get(episodeFile.id)).toBe("episode");
	});

	test("treats an explicit zero offset as the first page", async () => {
		const client = db.client();
		const firstId = await insertMovieMediaFile(client, "/media/first.mkv", "meta-first");
		const secondId = await insertMovieMediaFile(client, "/media/second.mkv", "meta-second");
		const expectedFirst = [firstId, secondId].toSorted()[0];
		if (!expectedFirst) throw new Error("Expected a seeded media file id");

		const files = await pluginMediaService.listAllMediaFiles({ offset: 0, limit: 1 });

		expect(files.map((file) => file.mediaFileId)).toEqual([expectedFirst]);
	});

	test("caps the default listing at ten thousand media files", async () => {
		const client = db.client();
		const firstId = await insertMovieMediaFile(client, "/media/limit-0.mkv", "meta-limit");
		const [base] = await client.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, firstId));
		if (!base?.movieId) throw new Error("Expected the seeded media file to belong to a movie");
		const { libraryId, movieId } = base;

		for (let start = 0; start < 10_000; start += 500) {
			const count = Math.min(500, 10_000 - start);
			await client.insert(schema.mediaFiles).values(
				Array.from({ length: count }, (_, index) => {
					const number = start + index + 1;

					return {
						libraryId,
						movieId,
						metadataId: "meta-limit",
						filePath: `/media/limit-${number}.mkv`,
						fileName: `limit-${number}.mkv`,
					};
				}),
			);
		}

		const files = await pluginMediaService.listAllMediaFiles();

		expect(files).toHaveLength(10_000);
	});
});
