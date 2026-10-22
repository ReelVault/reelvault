import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTreeSync } from "@/utils/directory.utils";
import { collectionRepository } from "./collections.repository";

describe("collectionRepository poster preview fast path", () => {
	let tempDir: string;
	let factory: DatabaseFactory;
	const spies: Array<{ mockRestore(): void }> = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "rv-collection-preview-fast-"));
		factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
		factory.migrate();
		spies.push(spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)));
	});

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		factory.shutdown();
		removeTreeSync(tempDir);
	});

	/** Seeds a shelf with `count` titles; `imageIdFor` decides which poster each title gets. */
	async function seedPosterShelf(collectionId: string, count: number, imageIdFor: (index: number) => string | null): Promise<void> {
		const db = factory.getClient();
		await db.insert(schema.collections).values({ id: collectionId, stableKey: collectionId, name: collectionId });

		for (let index = 0; index < count; index++) {
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

			const imageId = imageIdFor(index);
			if (!imageId) continue;
			await db
				.insert(schema.images)
				.values({ id: imageId, stableKey: imageId, localPath: `/${imageId}.png`, contentType: "image/png" })
				.onConflictDoNothing();
			await db.insert(schema.metadataImages).values({ metadataId: row.id, imageId, imageType: "poster" });
		}
	}

	test("keeps four distinct posters in shelf order when the fast window is enough", async () => {
		const collectionId = `shelf-${Math.random().toString(36).slice(2)}`;
		await seedPosterShelf(collectionId, 6, (index) => `poster-${index}`);

		const posters = (await collectionRepository.findByIdForRead(collectionId))?.posterImages ?? [];

		expect(posters.map((poster) => poster.imageId)).toEqual(["poster-0", "poster-1", "poster-2", "poster-3"]);
	});

	test("deduplicates one poster shared by a full fast window", async () => {
		const collectionId = `shelf-${Math.random().toString(36).slice(2)}`;
		await seedPosterShelf(collectionId, 20, () => "poster-shared");

		const posters = (await collectionRepository.findByIdForRead(collectionId))?.posterImages ?? [];

		expect(posters.map((poster) => poster.imageId)).toEqual(["poster-shared"]);
	});
});
