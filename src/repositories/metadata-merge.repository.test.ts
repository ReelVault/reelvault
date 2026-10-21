import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { metadataMergeRepository } from "./metadata-merge.repository";

const db = useTestDatabase();

async function insertMovie(title: string): Promise<string> {
	const [row] = await db
		.client()
		.insert(schema.metadata)
		.values({ stableKey: `merge-test-${crypto.randomUUID()}`, title, type: "movie", releaseDate: "2020-01-01" })
		.returning({ id: schema.metadata.id });
	if (!row) throw new Error("metadata insert returned no row");

	return row.id;
}

async function insertCollection(name: string): Promise<string> {
	const [row] = await db
		.client()
		.insert(schema.collections)
		.values({ stableKey: `merge-test-${crypto.randomUUID()}`, name: `${name} ${crypto.randomUUID()}` })
		.returning({ id: schema.collections.id });
	if (!row) throw new Error("collection insert returned no row");

	return row.id;
}

test("a merge moves the source's collections onto the target, keeps the target's order where both list it, and removes the source", async () => {
	const client = db.client();
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
