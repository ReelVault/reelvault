import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { metadataMergeRepository } from "./metadata-merge.repository";

let tempDir: string;
let factory: DatabaseFactory;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "rv-merge-"));
	factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
	factory.migrate();
	spies.push(
		spyOn(databaseFactory, "transaction").mockImplementation((callback, options) => factory.transaction(callback, options)),
		spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)),
	);
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	factory.shutdown();
	rmSync(tempDir, { recursive: true, force: true });
});

async function insertMovie(title: string): Promise<string> {
	const [row] = await factory
		.getClient()
		.insert(schema.metadata)
		.values({ stableKey: `merge-test-${crypto.randomUUID()}`, title, type: "movie", releaseDate: "2020-01-01" })
		.returning({ id: schema.metadata.id });
	if (!row) throw new Error("metadata insert returned no row");

	return row.id;
}

async function insertCollection(name: string): Promise<string> {
	const [row] = await factory
		.getClient()
		.insert(schema.collections)
		.values({ stableKey: `merge-test-${crypto.randomUUID()}`, name: `${name} ${crypto.randomUUID()}` })
		.returning({ id: schema.collections.id });
	if (!row) throw new Error("collection insert returned no row");

	return row.id;
}

test("a merged title takes the source's place in its collections and keeps its own where it was already listed", async () => {
	const client = factory.getClient();
	const target = await insertMovie("Target");
	const source = await insertMovie("Source");
	const onlySource = await insertCollection("Only source");
	const shared = await insertCollection("Shared");
	await client.insert(schema.metadataCollections).values([
		{ metadataId: source, collectionId: onlySource, sortOrder: 3 },
		{ metadataId: source, collectionId: shared, sortOrder: 1 },
		{ metadataId: target, collectionId: shared, sortOrder: 0 },
	]);

	await metadataMergeRepository.merge(target, source, "movie");

	const targetMemberships = await client
		.select({ collectionId: schema.metadataCollections.collectionId, sortOrder: schema.metadataCollections.sortOrder })
		.from(schema.metadataCollections)
		.where(eq(schema.metadataCollections.metadataId, target));
	expect(targetMemberships).toHaveLength(2);
	expect(targetMemberships).toContainEqual({ collectionId: onlySource, sortOrder: 3 });
	expect(targetMemberships).toContainEqual({ collectionId: shared, sortOrder: 0 });

	const sourceRow = await client.select({ id: schema.metadata.id }).from(schema.metadata).where(eq(schema.metadata.id, source));
	expect(sourceRow).toEqual([]);
});
