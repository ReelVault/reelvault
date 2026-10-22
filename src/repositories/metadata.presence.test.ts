import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { metadataRepository } from "./metadata.repository";

const db = useTestDatabase();

async function seedTitles(): Promise<void> {
	await db
		.client()
		.insert(schema.metadata)
		.values([
			{ id: "m-old", stableKey: "m-old", title: "Old", type: "movie", releaseDate: "2000-01-01" },
			{ id: "m-new", stableKey: "m-new", title: "New", type: "movie", releaseDate: "2001-01-01" },
			{ id: "m-none", stableKey: "m-none", title: "None", type: "movie", releaseDate: "2002-01-01" },
			{ id: "s-new", stableKey: "s-new", title: "Show", type: "tv_show", releaseDate: "2003-01-01" },
		]);
	await db
		.client()
		.update(schema.metadata)
		.set({ latestMediaCreatedAt: new Date(1_000 * 1_000) })
		.where(eq(schema.metadata.id, "m-old"));
	await db
		.client()
		.update(schema.metadata)
		.set({ latestMediaCreatedAt: new Date(2_000 * 1_000) })
		.where(eq(schema.metadata.id, "m-new"));
	await db
		.client()
		.update(schema.metadata)
		.set({ latestMediaCreatedAt: new Date(3_000 * 1_000) })
		.where(eq(schema.metadata.id, "s-new"));
}

describe("metadataRepository.findPage hasMediaFiles", () => {
	test("returns only titles whose presence stamp is set", async () => {
		await seedTitles();

		const page = await metadataRepository.findPage({ limit: 10, hasMediaFiles: true });

		expect(page.data.map((row) => row.id).toSorted()).toEqual(["m-new", "m-old", "s-new"]);
	});

	test("returns only fileless titles when the filter is false", async () => {
		await seedTitles();

		const page = await metadataRepository.findPage({ limit: 10, hasMediaFiles: false });

		expect(page.data.map((row) => row.id)).toEqual(["m-none"]);
	});
});

describe("metadataRepository.findRecentlyAddedByTypes", () => {
	test("orders each type by its newest presence stamp and skips fileless titles", async () => {
		await seedTitles();

		const result = await metadataRepository.findRecentlyAddedByTypes(["movie", "tv_show"], 10);

		expect(result.get("movie")?.map((row) => row.id)).toEqual(["m-new", "m-old"]);
		expect(result.get("tv_show")?.map((row) => row.id)).toEqual(["s-new"]);
	});
});
