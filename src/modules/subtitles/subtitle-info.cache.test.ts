import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { subtitlesRepository } from "@/repositories/subtitles.repository";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { SubtitleInfoCache } from "./subtitle-info.cache";

const db = useTestDatabase();

/** One embedded and one external subtitle on a movie file, read back through the real repositories. */
async function seedSubtitles(): Promise<string> {
	const client = db.client();
	const mediaFileId = await insertMovieMediaFile(client, "/media/movie.mkv", "meta-1");
	await client.insert(schema.subtitles).values([
		{ id: "sub-1", mediaFileId, language: "eng", format: "subrip", type: "embedded", streamIndex: 2 },
		{ id: "sub-2", mediaFileId, language: "pol", format: "srt", type: "external", filePath: "/subs/movie.pl.srt" },
	]);

	return mediaFileId;
}

describe("SubtitleInfoCache", () => {
	test("loads embedded info together with the media file path", async () => {
		const mediaFileId = await seedSubtitles();

		expect(await new SubtitleInfoCache().getOrSet("sub-1")).toEqual({
			type: "embedded",
			mediaFileId,
			streamIndex: 2,
			format: "subrip",
			mediaFilePath: "/media/movie.mkv",
		});
	});

	test("loads external info without a media file path", async () => {
		await seedSubtitles();

		const info = await new SubtitleInfoCache().getOrSet("sub-2");

		expect(info).toMatchObject({ type: "external", format: "srt" });
		expect(info.mediaFilePath).toBeUndefined();
	});

	test("throws not found for a missing subtitle", async () => {
		await seedSubtitles();

		await expect(new SubtitleInfoCache().getOrSet("missing")).rejects.toMatchObject({
			category: "not_found",
			code: "entity.not_found",
			params: { entityType: "Subtitle", entityId: "missing" },
		});
	});

	test("throws not found when the media file for an embedded subtitle disappears before its path is read", async () => {
		const mediaFileId = await seedSubtitles();
		// The second read is injected as a miss: the row can vanish between the two reads, which the foreign-key cascade does not cover.
		const cache = new SubtitleInfoCache({
			findSubtitle: (id) => subtitlesRepository.findByPrimaryId({ primaryId: id }),
			findMediaFilePath: () => Promise.resolve(null),
		});

		await expect(cache.getOrSet("sub-1")).rejects.toMatchObject({
			category: "not_found",
			code: "entity.not_found",
			params: { entityType: "Media file", entityId: mediaFileId },
		});
	});

	test("serves repeated reads from the cache until the subtitle is invalidated", async () => {
		await seedSubtitles();
		const cache = new SubtitleInfoCache();

		expect((await cache.getOrSet("sub-2")).format).toBe("srt");

		await db.client().update(schema.subtitles).set({ format: "vtt" }).where(eq(schema.subtitles.id, "sub-2"));
		expect((await cache.getOrSet("sub-2")).format).toBe("srt");

		cache.invalidate("sub-2");
		expect((await cache.getOrSet("sub-2")).format).toBe("vtt");
	});
});
