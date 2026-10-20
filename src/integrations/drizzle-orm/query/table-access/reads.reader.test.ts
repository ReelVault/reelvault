import { describe, expect, test } from "bun:test";
import { desc, eq, isNotNull } from "drizzle-orm";
import { serverConstants } from "@/config/server/server.constants";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { findOffsetPage } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";

const { client } = useTestDatabase();

const genres = defineTableAccess("genres", { primaryKeyColumn: "id" });
const schedules = defineTableAccess("workerSchedules", { primaryKeyColumn: "id" });

const createdAt = new Date(1_700_000_000_000);

describe("findExistingIds", () => {
	test("returns only the ids that exist, ignoring duplicates", async () => {
		await client()
			.insert(schema.genres)
			.values([
				{ id: "g1", stableKey: "s1", name: "Drama" },
				{ id: "g2", stableKey: "s2", name: "Comedy" },
			]);

		const existing = await genres.findExistingIds(["g1", "g1", "missing"]);

		expect(existing).toEqual(new Set(["g1"]));
	});

	test("chunks an oversized id list and still checks the last chunk", async () => {
		const ids = Array.from({ length: serverConstants.database.queryChunkSize + 1 }, (_, index) => `id-${index}`);
		const lastId = ids.at(-1);
		if (!lastId) throw new Error("test fixture is empty");

		await client().insert(schema.genres).values({ id: lastId, stableKey: "chunked", name: "Chunked" });

		const existing = await genres.findExistingIds(ids);

		expect(existing).toEqual(new Set([lastId]));
	});
});

describe("findOffsetPage", () => {
	test("breaks equal sort keys by the primary key so consecutive pages do not overlap", async () => {
		await client()
			.insert(schema.genres)
			.values([
				{ id: "g1", stableKey: "s1", name: "A", createdAt, updatedAt: createdAt },
				{ id: "g2", stableKey: "s2", name: "B", createdAt, updatedAt: createdAt },
				{ id: "g3", stableKey: "s3", name: "C", createdAt, updatedAt: createdAt },
			]);

		const first = await genres.findOffsetPage({ orderBy: desc(genres.table.createdAt), limit: 2, offset: 0 });
		const second = await genres.findOffsetPage({ orderBy: desc(genres.table.createdAt), limit: 2, offset: 2 });

		expect(first.total).toBe(3);
		expect(first.data.map((row) => row.id)).toEqual(["g3", "g2"]);
		expect(second.data.map((row) => row.id)).toEqual(["g1"]);
	});

	test("projects only the requested fields", async () => {
		await client().insert(schema.genres).values({ id: "g1", stableKey: "s1", name: "Drama" });

		const page = await genres.findOffsetPage({
			orderBy: desc(genres.table.createdAt),
			limit: 1,
			offset: 0,
			fields: parseFields({ fields: "id,name" }),
		});

		expect(page.data).toHaveLength(1);
		expect(Object.keys(page.data[0] ?? {}).toSorted()).toEqual(["id", "name"]);
	});

	test("reuses the cached total for the same count key", async () => {
		let countCalls = 0;

		const loadPage = async () =>
			await findOffsetPage({
				access: { tableName: "genres-cached-count-test", primaryKeyColumn: genres.primaryKeyColumn },
				orderBy: desc(genres.table.createdAt),
				limit: 1,
				offset: 0,
				countKey: { scope: "cached-count-test" },
				findMany: async () => [],
				count: () => {
					countCalls++;

					return Promise.resolve(7);
				},
			});

		const first = await loadPage();
		const second = await loadPage();

		expect(first.total).toBe(7);
		expect(second.total).toBe(7);
		expect(countCalls).toBe(1);
	});
});

describe("countAggregates", () => {
	test("counts the total, sums a column and counts matching rows in one row", async () => {
		await client()
			.insert(schema.workerSchedules)
			.values([
				{ id: "w1", workerId: "a", triggers: [], lastDurationMs: 10 },
				{ id: "w2", workerId: "b", triggers: [], lastDurationMs: 30 },
				{ id: "w3", workerId: "c", triggers: [] },
			]);

		const stats = await schedules.countAggregates({
			total: "total",
			sum: { key: "duration", column: schedules.table.lastDurationMs },
			counts: { ran: isNotNull(schedules.table.lastDurationMs) },
		});

		expect(stats).toEqual({ total: 3, duration: 40, ran: 2 });
	});

	test("counts rows by filter without a total", async () => {
		await client()
			.insert(schema.genres)
			.values([
				{ id: "g1", stableKey: "s1", name: "Drama" },
				{ id: "g2", stableKey: "s2", name: "Comedy" },
			]);

		const stats = await genres.countAggregates({
			total: false,
			counts: { drama: eq(genres.table.name, "Drama") },
		});

		expect(stats).toEqual({ drama: 1 });
	});
});
