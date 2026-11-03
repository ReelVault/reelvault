import { describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { metadataRepository } from "./metadata.repository";

const db = useTestDatabase();

/** Three titles whose createdAt order is unambiguous. */
async function seedCreatedAtTitles(): Promise<void> {
	const base = Date.UTC(2026, 0, 1);

	await db
		.client()
		.insert(schema.metadata)
		.values([
			{ id: "m-a", stableKey: "m-a", title: "A", type: "movie", releaseDate: "2001-01-01", createdAt: new Date(base + 1_000) },
			{ id: "m-b", stableKey: "m-b", title: "B", type: "movie", releaseDate: "2002-01-01", createdAt: new Date(base + 2_000) },
			{ id: "m-c", stableKey: "m-c", title: "C", type: "movie", releaseDate: "2003-01-01", createdAt: new Date(base + 3_000) },
		]);
}

describe("metadataRepository.findPage createdAt pagination", () => {
	test("returns the next offset page when sorting by createdAt descending", async () => {
		await seedCreatedAtTitles();

		const first = await metadataRepository.findPage({ limit: 2, page: 1, sortBy: "createdAt", sortOrder: "desc" });
		const second = await metadataRepository.findPage({ limit: 2, page: 2, sortBy: "createdAt", sortOrder: "desc" });

		expect(first.data.map((row) => row.id)).toEqual(["m-c", "m-b"]);
		expect(second.page).toBe(2);
		expect(second.data.map((row) => row.id)).toEqual(["m-a"]);
	});

	test("returns the next keyset page after a cursor when sorting by createdAt descending", async () => {
		await seedCreatedAtTitles();

		const first = await metadataRepository.findPage({ limit: 2, sortBy: "createdAt", sortOrder: "desc" });
		const cursor = first.nextCursor;
		if (cursor === undefined) throw new Error("first cursor page did not return nextCursor");

		const second = await metadataRepository.findPage({ limit: 2, sortBy: "createdAt", sortOrder: "desc", cursor });

		expect(second.data.map((row) => row.id)).toEqual(["m-a"]);
	});
});
