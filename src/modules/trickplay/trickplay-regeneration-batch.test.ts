import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { trickplayAdminService } from "@/services/trickplay/trickplay-admin.service";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";

const db = useTestDatabase();

/** Seeds one movie title with `fileCount` media files, each with a duration so regeneration picks it up; returns their ids in repository order. */
async function seedTitle(metadataId: string, fileCount: number): Promise<string[]> {
	const client = db.client();
	const firstId = await insertMovieMediaFile(client, `/media/${metadataId}-1.mkv`, metadataId);
	const [first] = await client.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, firstId));
	if (!first) throw new Error("The seeded media file should exist");

	for (let index = 2; index <= fileCount; index++) {
		await client.insert(schema.mediaFiles).values({
			libraryId: first.libraryId,
			metadataId,
			movieId: first.movieId,
			filePath: `/media/${metadataId}-${index}.mkv`,
			fileName: `${metadataId}-${index}.mkv`,
		});
	}
	await client.update(schema.mediaFiles).set({ duration: 1200 }).where(eq(schema.mediaFiles.metadataId, metadataId));

	const rows = await client
		.select({ id: schema.mediaFiles.id })
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.metadataId, metadataId));

	return rows.map((row) => row.id).toSorted();
}

test("a regeneration over several titles keeps scope order and stops at the cap in total", async () => {
	const first = await seedTitle("t-1", 2);
	const second = await seedTitle("t-2", 2);
	await seedTitle("t-3", 1);

	const ids = await trickplayAdminService.findMediaFileIdsForRegenerations(
		[
			{ kind: "title", id: "t-1" },
			{ kind: "title", id: "t-2" },
			{ kind: "title", id: "t-3" },
		],
		false,
		3,
	);

	// The third title is never reached: the cap is spent by the first title and one file of the second.
	expect(ids).toEqual([...first, ...second.slice(0, 1)]);
});

test("the matching count of several titles is the sum over the scopes", async () => {
	await seedTitle("t-1", 2);
	await seedTitle("t-2", 3);
	await seedTitle("t-3", 1);

	const total = await trickplayAdminService.countForRegenerations(
		[
			{ kind: "title", id: "t-1" },
			{ kind: "title", id: "t-2" },
		],
		true,
	);

	expect(total).toBe(5);
});
