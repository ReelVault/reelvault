import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { metadataPersistenceRepository } from "./metadata-persistence.repository";

const db = useTestDatabase();

async function insertMovie(): Promise<string> {
	const [row] = await db
		.client()
		.insert(schema.metadata)
		.values({
			stableKey: `rematch-test-${crypto.randomUUID()}`,
			title: "Kept title",
			type: "movie",
			releaseDate: "2001-01-01",
			overview: "Old overview",
		})
		.returning({ id: schema.metadata.id });
	if (!row) throw new Error("metadata insert returned no row");

	return row.id;
}

test("a rematch keeps a locked field and updates the unlocked ones", async () => {
	const metadataId = await insertMovie();

	await metadataPersistenceRepository.rematchProviderMetadata({
		metadataId,
		type: "movie",
		providerName: "tmdb",
		metadata: { externalId: "603", title: "Replaced title", releaseDate: "1999-03-31", overview: "New overview" },
		lockedFields: ["title"],
	});

	const [stored] = await db
		.client()
		.select({
			title: schema.metadata.title,
			overview: schema.metadata.overview,
			releaseDate: schema.metadata.releaseDate,
			primaryProviderId: schema.metadata.primaryProviderId,
		})
		.from(schema.metadata)
		.where(eq(schema.metadata.id, metadataId));

	expect(stored).toEqual({
		title: "Kept title",
		overview: "New overview",
		releaseDate: "1999-03-31",
		primaryProviderId: "tmdb",
	});
});

test("without locks a rematch overwrites the title", async () => {
	const metadataId = await insertMovie();

	await metadataPersistenceRepository.rematchProviderMetadata({
		metadataId,
		type: "movie",
		providerName: "tmdb",
		metadata: { externalId: "603", title: "Replaced title", releaseDate: "1999-03-31", overview: "New overview" },
	});

	const [stored] = await db
		.client()
		.select({ title: schema.metadata.title })
		.from(schema.metadata)
		.where(eq(schema.metadata.id, metadataId));

	expect(stored).toEqual({ title: "Replaced title" });
});
