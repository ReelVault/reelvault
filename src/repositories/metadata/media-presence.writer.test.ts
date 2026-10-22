import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { backfillLatestMediaCreatedAt, markLatestMediaCreatedAt, refreshLatestMediaCreatedAt } from "./media-presence.writer";

const db = useTestDatabase();

async function insertMetadata(ids: string[]): Promise<void> {
	await db
		.client()
		.insert(schema.metadata)
		.values(
			ids.map((id) => ({
				id,
				stableKey: id,
				title: id,
				type: "movie" as const,
				releaseDate: "2020-01-01",
			})),
		);
}

async function insertMediaFile(id: string, metadataId: string, createdAtSeconds: number): Promise<void> {
	await db.client().insert(schema.libraries).values({ id: "lib-1", name: "Library", type: "movies" }).onConflictDoNothing();
	await db
		.client()
		.insert(schema.movies)
		.values({ id: `movie-${metadataId}`, stableKey: `movie-${metadataId}`, metadataId })
		.onConflictDoNothing();
	await db
		.client()
		.insert(schema.mediaFiles)
		.values({
			id,
			libraryId: "lib-1",
			metadataId,
			movieId: `movie-${metadataId}`,
			fileName: `${id}.mkv`,
			filePath: `/media/${id}.mkv`,
			isEnabled: true,
			createdAt: new Date(createdAtSeconds * 1_000),
		});
}

function storedLatest(metadataId: string): number | null {
	const row = db.sqlite().query("SELECT latest_media_created_at AS value FROM metadata WHERE id = ?").get(metadataId) as
		| { value: number | null }
		| undefined;

	return row?.value ?? null;
}

describe("markLatestMediaCreatedAt", () => {
	test("keeps the newest file timestamp when an older file is added later", async () => {
		await insertMetadata(["m-1"]);

		await markLatestMediaCreatedAt("m-1", new Date(1_000 * 1_000));
		await markLatestMediaCreatedAt("m-1", new Date(2_000 * 1_000));
		await markLatestMediaCreatedAt("m-1", new Date(1_500 * 1_000));

		expect(storedLatest("m-1")).toBe(2_000);
	});
});

describe("refreshLatestMediaCreatedAt", () => {
	test("drops the stored stamp to the remaining newest file after the newest one is deleted", async () => {
		await insertMetadata(["m-1"]);
		await insertMediaFile("f-old", "m-1", 1_000);
		await insertMediaFile("f-new", "m-1", 2_000);
		await markLatestMediaCreatedAt("m-1", new Date(2_000 * 1_000));

		await db.client().delete(schema.mediaFiles).where(eq(schema.mediaFiles.id, "f-new"));
		await refreshLatestMediaCreatedAt(["m-1"]);

		expect(storedLatest("m-1")).toBe(1_000);
	});

	test("clears the stamp when the last file is gone", async () => {
		await insertMetadata(["m-1"]);
		await insertMediaFile("f-only", "m-1", 1_000);
		await markLatestMediaCreatedAt("m-1", new Date(1_000 * 1_000));

		await db.client().delete(schema.mediaFiles).where(eq(schema.mediaFiles.id, "f-only"));
		await refreshLatestMediaCreatedAt(["m-1"]);

		expect(storedLatest("m-1")).toBeNull();
	});
});

describe("backfillLatestMediaCreatedAt", () => {
	test("fills titles that have files and leaves fileless titles NULL", async () => {
		await insertMetadata(["m-with", "m-without"]);
		await insertMediaFile("f-1", "m-with", 3_000);

		await backfillLatestMediaCreatedAt();

		expect(storedLatest("m-with")).toBe(3_000);
		expect(storedLatest("m-without")).toBeNull();
	});
});
