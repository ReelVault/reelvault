import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { parseFieldsForRead } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { removeTreeSync } from "@/utils/directory.utils";
import { invalidateResponseBodies } from "@/utils/response-body.cache";
import { collectionRepository } from "./collections.repository";

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
		removeTreeSync(tempDir);
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

	// The name filter matches by substring, so the second collection falls inside the first query.
	test("keeps serving the grouped count for a repeated page within its window", async () => {
		const name = `cache-probe-${crypto.randomUUID()}`;
		await seedCollection(name, 1);
		const query = { limit: 24, minItems: 1, name };
		expect((await collectionRepository.findPage(query)).total).toBe(1);

		// The count cache lives for 10 s and writes do not flush it, so the repeated page keeps the first total.
		await seedCollection(`${name}-second`, 1);
		expect((await collectionRepository.findPage(query)).total).toBe(1);
	});
});

describe("collectionRepository poster previews", () => {
	let tempDir: string;
	let factory: DatabaseFactory;
	const spies: Array<{ mockRestore(): void }> = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "rv-collection-previews-"));
		factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
		factory.migrate();
		spies.push(spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)));
	});

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		factory.shutdown();
		removeTreeSync(tempDir);
	});

	// Collection ids are process-global cache keys, so each test uses its own.
	// Returns the id of the collection's first title.
	async function seedShelf(collectionId: string): Promise<string> {
		const db = factory.getClient();
		await db.insert(schema.collections).values({ id: collectionId, stableKey: collectionId, name: collectionId });

		let firstTitleId: string | undefined;
		for (let index = 0; index < 2; index++) {
			const [row] = await db
				.insert(schema.metadata)
				.values({
					stableKey: `${collectionId}-${index}`,
					title: `${collectionId} ${index}`,
					type: "movie",
					releaseDate: "2001-01-01",
					overview: "Overview",
				})
				.returning({ id: schema.metadata.id });
			if (!row) throw new Error("metadata insert returned no row");
			await db.insert(schema.metadataCollections).values({ metadataId: row.id, collectionId, sortOrder: index });
			firstTitleId ??= row.id;
		}
		if (!firstTitleId) throw new Error("seed produced no titles");

		return firstTitleId;
	}

	async function insertPoster(db: DatabaseTransaction, metadataId: string) {
		const imageId = `poster-${metadataId}`;
		await db.insert(schema.images).values({ id: imageId, stableKey: imageId, localPath: `/${imageId}.png`, contentType: "image/png" });
		await db.insert(schema.metadataImages).values({ metadataId, imageId, imageType: "poster" });
	}

	test("serves previews from the cache until a write flushes list bodies", async () => {
		const collectionId = `shelf-${Math.random().toString(36).slice(2)}`;
		const firstTitleId = await seedShelf(collectionId);

		expect((await collectionRepository.findByIdForRead(collectionId))?.posterImages).toEqual([]);

		// A direct insert skips the write path's invalidation, so the cached preview holds.
		await insertPoster(factory.getClient(), firstTitleId);
		expect((await collectionRepository.findByIdForRead(collectionId))?.posterImages).toEqual([]);

		invalidateResponseBodies();
		const posters = (await collectionRepository.findByIdForRead(collectionId))?.posterImages ?? [];
		expect(posters.map((poster) => poster.imageId)).toEqual([`poster-${firstTitleId}`]);
	});

	test("does not cache previews read inside a transaction that rolls back", async () => {
		const rollback = new Error("roll back");
		const collectionId = `shelf-${Math.random().toString(36).slice(2)}`;
		const firstTitleId = await seedShelf(collectionId);

		await expect(
			factory.transaction(async (tx) => {
				await insertPoster(tx, firstTitleId);
				const inside = await collectionRepository.findById({ primaryId: collectionId, fields: parseFieldsForRead(), tx });
				expect(inside?.posterImages).toHaveLength(1);

				throw rollback;
			}),
		).rejects.toBe(rollback);

		expect((await collectionRepository.findByIdForRead(collectionId))?.posterImages).toEqual([]);
	});
});
