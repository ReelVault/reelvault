import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginMetadataService } from "./plugin.metadata";

const db = useTestDatabase();

/** Links a movie metadata row to one provider row, the way a provider match is stored. */
async function linkProvider(metadataId: string, name: string, externalId: string): Promise<void> {
	const client = db.client();
	const [provider] = await client
		.insert(schema.providers)
		.values({ stableKey: `${name}-${externalId}`, name, entityType: "movie", externalId })
		.returning({ id: schema.providers.id });
	if (!provider) throw new Error("Expected the provider insert to return a row");
	await client.insert(schema.metadataProviders).values({ metadataId, providerId: provider.id });
}

describe("pluginMetadataService.get", () => {
	test("maps nullable fields to undefined and providers to externalIds", async () => {
		const client = db.client();
		await insertMovieMediaFile(client, "/media/movie.mkv", "meta-1");
		await client.update(schema.metadata).set({ title: "Movie", overview: "Plot" }).where(eq(schema.metadata.id, "meta-1"));
		await linkProvider("meta-1", "tmdb", "42");
		await linkProvider("meta-1", "imdb", "tt0000042");

		const result = await pluginMetadataService.get("meta-1");

		expect(result).toMatchObject({
			id: "meta-1",
			type: "movie",
			title: "Movie",
			overview: "Plot",
			releaseDate: "2020-01-01",
		});
		expect(result?.originalTitle).toBeUndefined();
		expect(result?.tagline).toBeUndefined();
		expect(result?.status).toBeUndefined();
		expect(result?.externalIds).toHaveLength(2);
		expect(result?.externalIds).toEqual(
			expect.arrayContaining([
				{ providerId: "tmdb", entityType: "movie", externalId: "42" },
				{ providerId: "imdb", entityType: "movie", externalId: "tt0000042" },
			]),
		);
	});

	test("returns null for unknown metadata", async () => {
		await expect(pluginMetadataService.get("missing")).resolves.toBeNull();
	});
});

describe("pluginMetadataService.findManyByExternalIds", () => {
	test("maps availability rows with file counts", async () => {
		const client = db.client();
		await insertMovieMediaFile(client, "/media/movie.mkv", "meta-1");
		await client.update(schema.metadata).set({ title: "Movie" }).where(eq(schema.metadata.id, "meta-1"));
		await linkProvider("meta-1", "tmdb", "42");
		await client
			.insert(schema.metadata)
			.values({ id: "meta-2", stableKey: "meta-2", title: "Other", type: "movie", releaseDate: "2019-01-01" });
		await linkProvider("meta-2", "tmdb", "43");

		const rows = await pluginMetadataService.findManyByExternalIds("tmdb", ["42", "43"], "movie");

		expect(rows).toHaveLength(2);
		expect(rows).toEqual(
			expect.arrayContaining([
				{ externalId: "42", metadataId: "meta-1", title: "Movie", type: "movie", hasFiles: true, fileCount: 1 },
				{ externalId: "43", metadataId: "meta-2", title: "Other", type: "movie", hasFiles: false, fileCount: 0 },
			]),
		);
	});
});

describe("pluginMetadataService.findByExternalId", () => {
	test("returns the availability of the matching external id", async () => {
		await insertMovieMediaFile(db.client(), "/media/movie.mkv", "meta-1");
		await linkProvider("meta-1", "tmdb", "42");

		await expect(pluginMetadataService.findByExternalId("tmdb", "42", "movie")).resolves.toMatchObject({
			metadataId: "meta-1",
			hasFiles: true,
		});
	});

	test("returns null when nothing matches", async () => {
		await expect(pluginMetadataService.findByExternalId("tmdb", "nope", "movie")).resolves.toBeNull();
	});
});
