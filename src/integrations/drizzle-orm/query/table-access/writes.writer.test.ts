import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { assertPresent } from "@/utils/domain.errors";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";

const { client } = useTestDatabase();

const genres = defineTableAccess("genres", { primaryKeyColumn: "id" });

const createdAt = new Date(1_700_000_000_000);

describe("upsert", () => {
	test("does nothing for an empty value list", async () => {
		await expect(genres.upsert({ values: [], target: genres.table.id })).resolves.toEqual([]);
	});

	test("the inserted set updates the provided columns but keeps the original creation time", async () => {
		await client().insert(schema.genres).values({ id: "g1", stableKey: "s1", name: "Drama", createdAt, updatedAt: createdAt });

		await genres.upsert({ values: { id: "g1", stableKey: "s1", name: "Comedy" }, target: genres.table.id });

		const row = await genres.selectFirstById({ primaryId: "g1" });
		assertPresent(row, "genre");
		expect(row.name).toBe("Comedy");
		expect(row.createdAt.getTime()).toBe(createdAt.getTime());
	});

	test("an explicit set leaves columns it does not list unchanged", async () => {
		await client().insert(schema.genres).values({ id: "g1", stableKey: "s1", name: "Drama" });

		await genres.upsert({
			values: { id: "g1", stableKey: "s1", name: "Comedy" },
			target: genres.table.id,
			set: { name: "Thriller" },
		});

		const row = await genres.selectFirstById({ primaryId: "g1" });
		assertPresent(row, "genre");
		expect(row.name).toBe("Thriller");
		expect(row.stableKey).toBe("s1");
	});

	test("upserts a multi-row batch and returns every written row", async () => {
		await client()
			.insert(schema.genres)
			.values([
				{ id: "g1", stableKey: "s1", name: "Drama" },
				{ id: "g2", stableKey: "s2", name: "Comedy" },
			]);

		const rows = await genres.upsert({
			values: [
				{ id: "g1", stableKey: "s1", name: "Thriller" },
				{ id: "g2", stableKey: "s2", name: "Horror" },
			],
			target: genres.table.id,
			returning: true,
		});

		expect(rows.map((row) => row.name).toSorted()).toEqual(["Horror", "Thriller"]);
		const stored = await genres.selectMany({ orderBy: asc(genres.table.id) });
		expect(stored.map((row) => row.name)).toEqual(["Thriller", "Horror"]);
	});

	test("skips the update when setWhere is false and returns no row", async () => {
		await client().insert(schema.genres).values({ id: "g1", stableKey: "s1", name: "Drama" });

		const rows = await genres.upsert({
			values: { id: "g1", stableKey: "s1", name: "Comedy" },
			target: genres.table.id,
			set: { name: "Comedy" },
			setWhere: eq(genres.table.name, "Other"),
			returning: true,
		});

		expect(rows).toEqual([]);
		const stored = await genres.selectFirstById({ primaryId: "g1" });
		expect(stored?.name).toBe("Drama");
	});
});

describe("updateManyFields", () => {
	test("assigns each row its own value and skips rows without values", async () => {
		await client()
			.insert(schema.genres)
			.values([
				{ id: "g1", stableKey: "s1", name: "Drama" },
				{ id: "g2", stableKey: "s2", name: "Comedy" },
			]);

		await genres.updateManyFields({
			columns: { name: genres.table.name },
			updates: [
				{ id: "g1", values: { name: "Thriller" } },
				{ id: "g2", values: {} },
			],
		});

		const rows = await genres.selectMany({ orderBy: asc(genres.table.id) });
		expect(rows.map((row) => row.name)).toEqual(["Thriller", "Comedy"]);
	});
});
