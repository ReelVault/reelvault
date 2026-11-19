import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { findForStreamingDuration } from "./playback.reader";
import { deleteByIds, deleteByLibraryAndPathsAndGetCleanup, replaceTechnicalData } from "./writes.writer";

const db = useTestDatabase();

describe("streaming duration cache", () => {
	test("serves no duration for a media file removed by id", async () => {
		const client = db.client();
		const mediaId = await insertMovieMediaFile(client, "/media/cache-by-id.mkv", "cache-by-id");
		expect(await findForStreamingDuration(mediaId)).toEqual({ id: mediaId, duration: null });

		await deleteByIds([mediaId]);

		expect(await findForStreamingDuration(mediaId)).toBeUndefined();
	});

	test("serves no duration for a media file removed by library path", async () => {
		const client = db.client();
		const mediaId = await insertMovieMediaFile(client, "/media/cache-by-path.mkv", "cache-by-path");
		const [row] = await client
			.select({ libraryId: schema.mediaFiles.libraryId })
			.from(schema.mediaFiles)
			.where(eq(schema.mediaFiles.id, mediaId));
		expect(await findForStreamingDuration(mediaId)).toEqual({ id: mediaId, duration: null });

		await deleteByLibraryAndPathsAndGetCleanup(row?.libraryId ?? "", ["/media/cache-by-path.mkv"]);

		expect(await findForStreamingDuration(mediaId)).toBeUndefined();
	});

	test("serves the refreshed duration after a technical data replacement", async () => {
		const client = db.client();
		const mediaId = await insertMovieMediaFile(client, "/media/cache-technical.mkv", "cache-technical");
		expect(await findForStreamingDuration(mediaId)).toEqual({ id: mediaId, duration: null });

		await replaceTechnicalData({
			mediaFileId: mediaId,
			data: {
				formatName: "matroska",
				duration: 3_600,
				bitRate: null,
				source: null,
				edition: null,
				qualityTag: "1080p",
				videoStreams: [],
				audioStreams: [],
				subtitles: [],
			},
			size: 2_500,
			sourceMtimeMs: 123,
		});

		expect(await findForStreamingDuration(mediaId)).toEqual({ id: mediaId, duration: 3_600 });
	});
});
