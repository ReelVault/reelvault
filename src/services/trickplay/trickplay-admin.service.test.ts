import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { mediaArtifactsService } from "@/services/artifacts/media-artifacts.service";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { trickplayAdminService } from "./trickplay-admin.service";

// Trickplay previews are stored artifacts; the counts and the removal are read back from them.
const db = useTestDatabase();

async function seedPreviews(): Promise<{ fileA: string; fileB: string }> {
	const fileA = await insertMovieMediaFile(db.client(), "/movies/a.mkv", "m-a");
	const fileB = await insertMovieMediaFile(db.client(), "/movies/b.mkv", "m-b");
	for (let index = 0; index < 2; index++) {
		await mediaArtifactsService.write(CORE_ARTIFACTS_OWNER, {
			mediaFileId: fileA,
			kind: "trickplay",
			contentType: "image/webp",
			content: new TextEncoder().encode(`sprite-${index}`),
		});
	}

	return { fileA, fileB };
}

async function previewCount(mediaFileId: string): Promise<number> {
	const artifacts = await mediaArtifactsService.list(mediaFileId);

	return artifacts.filter((artifact) => artifact.kind === "trickplay").length;
}

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

describe("trickplayAdminService.deletePreviews", () => {
	test("a dry run counts the previews it would remove and removes none", async () => {
		const { fileA, fileB } = await seedPreviews();

		expect(await trickplayAdminService.deletePreviews([fileA, fileB, fileA], { dryRun: true })).toEqual({ mediaFiles: 1, artifacts: 2 });
		expect(await previewCount(fileA)).toBe(2);
	});

	test("removes the core previews of each distinct file and counts the files that had some", async () => {
		const { fileA, fileB } = await seedPreviews();

		expect(await trickplayAdminService.deletePreviews([fileA, fileB, fileA])).toEqual({ mediaFiles: 1, artifacts: 2 });
		expect(await previewCount(fileA)).toBe(0);
		expect(await previewCount(fileB)).toBe(0);
	});
});

describe("trickplayAdminService regeneration scopes", () => {
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
});
