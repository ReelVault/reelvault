import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { QueryFiltering } from "./filtering";

const client = databaseFactory.getClient();

describe("QueryFiltering", () => {
	test("bounds comma-separated filter values", () => {
		expect(() => QueryFiltering.parseCommaSeparated(Array.from({ length: 501 }, (_, index) => `id-${index}`).join(","))).toThrow(
			"Filter must not contain more than 500 values",
		);
	});

	test("m2m filter correctly binds list of UUIDs without syntax error", () => {
		const uuids = ["01a01b49-a3ca-7299-861b-0ed7249b0baf", "01a01b49-a3ca-7299-861b-1128825c646f", "01a01b49-a3ca-7299-861b-1754f42f82da"];
		const filter = QueryFiltering.m2m(
			schema.metadata.id,
			uuids.join(","),
			schema.metadataGenres,
			schema.metadataGenres.metadataId,
			schema.metadataGenres.genreId,
		);
		expect(filter).toBeDefined();
	});

	test("like treats % and _ as literal text, not wildcards", async () => {
		await client.run(
			sql.raw(`
				CREATE TABLE IF NOT EXISTS libraries (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					type TEXT NOT NULL,
					metadata_storage_mode TEXT, sidecar_flavor TEXT NOT NULL DEFAULT 'reelvault' NOT NULL DEFAULT 'database',
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`),
		);
		await client.delete(schema.libraries);
		await client.insert(schema.libraries).values([
			{ id: "l-1", name: "50%", type: "movies", createdAt: new Date(), updatedAt: new Date() },
			{ id: "l-2", name: "50x", type: "movies", createdAt: new Date(), updatedAt: new Date() },
			{ id: "l-3", name: "a_b", type: "movies", createdAt: new Date(), updatedAt: new Date() },
			{ id: "l-4", name: "axb", type: "movies", createdAt: new Date(), updatedAt: new Date() },
		]);

		const percentMatches = await client
			.select({ name: schema.libraries.name })
			.from(schema.libraries)
			.where(QueryFiltering.like(schema.libraries.name, "50%"));
		const underscoreMatches = await client
			.select({ name: schema.libraries.name })
			.from(schema.libraries)
			.where(QueryFiltering.like(schema.libraries.name, "a_b"));

		expect(percentMatches).toEqual([{ name: "50%" }]);
		expect(underscoreMatches).toEqual([{ name: "a_b" }]);
		await client.delete(schema.libraries);
	});
});
