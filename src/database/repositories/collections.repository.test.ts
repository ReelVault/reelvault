import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { collectionRepository } from "./collections.repository";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("collectionRepository.findPage count cache", () => {
	test("serves the grouped count from the cache on a repeated page", async () => {
		const countCalls: number[] = [];
		activeStubs.push(
			stubMethod(collectionRepository, "countWithMinimumMetadata", () => {
				countCalls.push(1);

				return Promise.resolve(1);
			}),
			// Empty page ids short-circuit before findMany, so the count is the only
			// statement under test.
			stubMethod(collectionRepository, "findPageIdsWithMinimumMetadata", () => Promise.resolve([])),
		);

		// Unique name filter keeps the key distinct from other tests sharing the
		// process-global count cache.
		const query = { limit: 24, name: `cache-probe-${Math.random().toString(36).slice(2)}` };
		await collectionRepository.findPage(query);
		await collectionRepository.findPage(query);

		expect(countCalls).toHaveLength(1);
	});
});

describe("collectionRepository minimum metadata threshold", () => {
	let tempDir: string;
	let factory: DatabaseFactory;
	const spies: Array<{ mockRestore(): void }> = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "rv-collections-"));
		factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
		factory.migrate();
		spies.push(spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)));
	});

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		factory.shutdown();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function seedCollection(id: string, titleCount: number) {
		const db = factory.getClient();
		await db.insert(schema.collections).values({ id, stableKey: id, name: id });

		for (let index = 0; index < titleCount; index++) {
			const [row] = await db
				.insert(schema.metadata)
				.values({ stableKey: `${id}-${index}`, title: `${id} ${index}`, type: "movie", releaseDate: "2001-01-01", overview: "Overview" })
				.returning({ id: schema.metadata.id });
			if (!row) throw new Error("metadata insert returned no row");
			await db.insert(schema.metadataCollections).values({ metadataId: row.id, collectionId: id, sortOrder: index });
		}
	}

	test("counts only collections with at least minItems titles", async () => {
		await seedCollection("single", 1);
		await seedCollection("pair", 2);
		await seedCollection("triple", 3);

		expect(await collectionRepository.countWithMinimumMetadata({ minItems: 1 })).toBe(3);
		expect(await collectionRepository.countWithMinimumMetadata({ minItems: 2 })).toBe(2);
		expect(await collectionRepository.countWithMinimumMetadata({ minItems: 3 })).toBe(1);
	});

	test("pages only collections with at least minItems titles", async () => {
		await seedCollection("single", 1);
		await seedCollection("pair", 2);
		await seedCollection("triple", 3);

		const ids = await collectionRepository.findPageIdsWithMinimumMetadata({
			minItems: 2,
			orderBy: undefined,
			limit: 10,
			offset: 0,
		});

		expect(ids.toSorted()).toEqual(["pair", "triple"]);
	});
});
