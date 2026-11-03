import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createLibraryStatsCaches } from "@/repositories/libraries/shared.types";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { deleteWithDependents } from "./remove.writer";

const db = useTestDatabase();

describe("deleteWithDependents paging", () => {
	test("collects cleanup data across multiple pages and removes only the deleted library's rows", async () => {
		const client = db.client();
		const mediaIds: string[] = [];
		for (let index = 0; index < 5; index++) {
			mediaIds.push(await insertMovieMediaFile(client, `/media/movie-${index}.mkv`, `movie-${index}`));
		}

		const [firstMedia] = await client
			.select({ libraryId: schema.mediaFiles.libraryId })
			.from(schema.mediaFiles)
			.where(eq(schema.mediaFiles.id, mediaIds[0] ?? ""));
		if (!firstMedia) throw new Error("Expected the seeded media file");

		await client.insert(schema.mediaArtifacts).values(
			mediaIds.map((mediaFileId, index) => ({
				id: `artifact-${index}`,
				stableKey: `artifact-stable-${index}`,
				mediaFileId,
				pluginId: "core",
				kind: "chapters" as const,
				contentType: "text/vtt",
				storageKey: `artifact-storage-${index}`,
			})),
		);
		await client.insert(schema.subtitles).values(
			mediaIds.map((mediaFileId, index) => ({
				id: `subtitle-${index}`,
				mediaFileId,
				language: "en",
				format: "vtt",
				type: "external" as const,
				filePath: `/subtitles/${index}.vtt`,
			})),
		);

		const cleanup = await deleteWithDependents(createLibraryStatsCaches(), firstMedia.libraryId, 2);

		expect(cleanup.artifactStorageKeys.toSorted()).toEqual([
			"artifact-storage-0",
			"artifact-storage-1",
			"artifact-storage-2",
			"artifact-storage-3",
			"artifact-storage-4",
		]);
		expect(cleanup.subtitleIds.toSorted()).toEqual(["subtitle-0", "subtitle-1", "subtitle-2", "subtitle-3", "subtitle-4"]);
		expect(
			await client.select({ id: schema.mediaFiles.id }).from(schema.mediaFiles).where(inArray(schema.mediaFiles.id, mediaIds)),
		).toEqual([]);
		expect(
			await client.select({ id: schema.libraries.id }).from(schema.libraries).where(eq(schema.libraries.id, firstMedia.libraryId)),
		).toEqual([]);
	});
});
