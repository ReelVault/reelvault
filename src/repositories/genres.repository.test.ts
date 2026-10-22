import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTreeSync } from "@/utils/directory.utils";
import { genreRepository } from "./genres.repository";

// The shared named-entity pipeline runs through the genre repository, its real caller, against the migrated test database.
let tempDir: string;
let factory: DatabaseFactory;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "rv-provider-sync-"));
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
	removeTreeSync(tempDir);
});

async function insertTitle(): Promise<string> {
	const [row] = await factory
		.getClient()
		.insert(schema.metadata)
		.values({ stableKey: "sync-title", title: "Title", type: "movie", releaseDate: "2001-01-01" })
		.returning({ id: schema.metadata.id });
	if (!row) throw new Error("metadata insert returned no row");

	return row.id;
}

test("stores one genre per unique trimmed name, skips blank names, and links the title to it once", async () => {
	const metadataId = await insertTitle();

	await genreRepository.process({
		metadataId,
		providerName: "tmdb",
		items: [
			{ id: "g-1", name: "  Action " },
			{ id: "g-2", name: "Action" },
			{ id: "g-3", name: "   " },
		],
	});

	const client = factory.getClient();
	const genres = await client
		.select({ id: schema.genres.id, name: schema.genres.name, stableKey: schema.genres.stableKey })
		.from(schema.genres);
	// Stable key is namespaced by entity type (hex-encoded: 67656e7265 = "genre") and value (616374696f6e = "action").
	expect(genres.map(({ name, stableKey }) => ({ name, stableKey }))).toEqual([
		{ name: "Action", stableKey: "v1:local:67656e7265:616374696f6e" },
	]);
	const links = await client
		.select({ genreId: schema.metadataGenres.genreId })
		.from(schema.metadataGenres)
		.where(eq(schema.metadataGenres.metadataId, metadataId));
	const [genre] = genres;
	if (!genre) throw new Error("Expected the genre insert to write a row");
	expect(links).toEqual([{ genreId: genre.id }]);
});

test("links every provider row that resolves to the same genre", async () => {
	const metadataId = await insertTitle();

	await genreRepository.process({
		metadataId,
		providerName: "tmdb",
		items: [
			{ id: "g-1", name: "Action" },
			{ id: "g-2", name: "Action" },
		],
	});

	const linked = await factory
		.getClient()
		.select({ externalId: schema.providers.externalId })
		.from(schema.genreProviders)
		.innerJoin(schema.providers, eq(schema.providers.id, schema.genreProviders.providerId));
	expect(linked.map((row) => row.externalId).toSorted()).toEqual(["g-1", "g-2"]);
});
