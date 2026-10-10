import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { metadataPersistenceRepository } from "./metadata-persistence.repository";

let tempDir: string;
let factory: DatabaseFactory;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "rv-rematch-"));
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

async function insertMovie(): Promise<string> {
	const [row] = await factory
		.getClient()
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

	const [stored] = await factory
		.getClient()
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

test("without locks a rematch overwrites every scalar field", async () => {
	const metadataId = await insertMovie();

	await metadataPersistenceRepository.rematchProviderMetadata({
		metadataId,
		type: "movie",
		providerName: "tmdb",
		metadata: { externalId: "603", title: "Replaced title", releaseDate: "1999-03-31", overview: "New overview" },
	});

	const [stored] = await factory
		.getClient()
		.select({ title: schema.metadata.title })
		.from(schema.metadata)
		.where(eq(schema.metadata.id, metadataId));

	expect(stored).toEqual({ title: "Replaced title" });
});
