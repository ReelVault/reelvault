import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { QueryFields } from "@/database/utils/fields";
import { metadataRepository } from "./metadata.repository";

const RELATION_KEYS = [
	"collections",
	"companies",
	"genres",
	"keywords",
	"cast",
	"crew",
	"images",
	"rating",
	"providers",
	"lockedFields",
] as const;
type RelationKey = (typeof RELATION_KEYS)[number];

let tempDir: string;
let factory: DatabaseFactory;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "rv-metadata-relations-"));
	factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
	factory.migrate();
	spies.push(spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)));
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	factory.shutdown();
	rmSync(tempDir, { recursive: true, force: true });
});

function pickRelations(value: Record<RelationKey, unknown>): Record<RelationKey, unknown> {
	return Object.fromEntries(RELATION_KEYS.map((key) => [key, value[key]])) as Record<RelationKey, unknown>;
}

async function insertId(insert: Promise<Array<{ id: string }>>): Promise<string> {
	const [row] = await insert;
	if (!row) throw new Error("insert returned no row");

	return row.id;
}

/** One title that populates every relation, plus a bare title that has none. */
async function seedTitles(): Promise<{ relatedId: string; bareId: string }> {
	const db = factory.getClient();
	const relatedId = await insertId(
		db
			.insert(schema.metadata)
			.values({ stableKey: "relations-related", title: "Related", type: "movie", releaseDate: "2001-01-01", overview: "Overview" })
			.returning({ id: schema.metadata.id }),
	);
	const bareId = await insertId(
		db
			.insert(schema.metadata)
			.values({ stableKey: "relations-bare", title: "Bare", type: "movie", releaseDate: "2002-01-01", overview: "Overview" })
			.returning({ id: schema.metadata.id }),
	);

	await db.insert(schema.genres).values([
		{ id: "genre-drama", stableKey: "genre-drama", name: "Drama" },
		{ id: "genre-thriller", stableKey: "genre-thriller", name: "Thriller" },
	]);
	await db.insert(schema.metadataGenres).values([
		{ metadataId: relatedId, genreId: "genre-drama" },
		{ metadataId: relatedId, genreId: "genre-thriller" },
	]);

	await db.insert(schema.keywords).values({ id: "keyword-heist", stableKey: "keyword-heist", name: "heist" });
	await db.insert(schema.metadataKeywords).values({ metadataId: relatedId, keywordId: "keyword-heist" });

	await db
		.insert(schema.collections)
		.values({ id: "collection-saga", stableKey: "collection-saga", name: "Saga", sortMode: "alphabetical" });
	await db.insert(schema.metadataCollections).values({ metadataId: relatedId, collectionId: "collection-saga", sortOrder: 1 });

	await db.insert(schema.companies).values([
		{ id: "company-a", stableKey: "company-a", name: "Studio A" },
		{ id: "company-b", stableKey: "company-b", name: "Studio B" },
	]);
	await db.insert(schema.metadataCompanies).values([
		{ metadataId: relatedId, companyId: "company-a" },
		{ metadataId: relatedId, companyId: "company-b" },
	]);

	await db
		.insert(schema.providers)
		.values({ id: "provider-tmdb", stableKey: "provider-tmdb", name: "TMDB", entityType: "movie", externalId: "603" });
	await db.insert(schema.metadataProviders).values({ metadataId: relatedId, providerId: "provider-tmdb" });

	await db.insert(schema.people).values([
		{ id: "person-lead", stableKey: "person-lead", name: "Lead Actor" },
		{ id: "person-support", stableKey: "person-support", name: "Support Actor" },
		{ id: "person-director", stableKey: "person-director", name: "Director" },
	]);
	await db.insert(schema.metadataCast).values([
		{ metadataId: relatedId, personId: "person-support", role: "Support", character: null, sortOrder: 2 },
		{ metadataId: relatedId, personId: "person-lead", role: "Lead", character: "Hero", sortOrder: 1 },
	]);
	await db
		.insert(schema.metadataCrew)
		.values({ metadataId: relatedId, personId: "person-director", job: "Director", department: "Directing" });

	await db.insert(schema.images).values([
		{
			id: "image-poster",
			stableKey: "image-poster",
			localPath: "/images/poster.webp",
			contentType: "image/webp",
			width: 300,
			height: 450,
			fileSize: 1000,
			optimizationVersion: 1,
		},
		{
			id: "image-backdrop",
			stableKey: "image-backdrop",
			localPath: "/images/backdrop.webp",
			contentType: "image/webp",
			width: 1280,
			height: 720,
			fileSize: 2000,
			optimizationVersion: 1,
		},
	]);
	await db.insert(schema.metadataImages).values([
		{ metadataId: relatedId, imageId: "image-poster", imageType: "poster" },
		{ metadataId: relatedId, imageId: "image-backdrop", imageType: "backdrop" },
	]);

	await db.insert(schema.metadataRatings).values([
		{ metadataId: relatedId, source: "tmdb", label: "TMDB", value: 7, votes: 100, maxValue: 10, url: "https://example.test/tmdb" },
		{ metadataId: relatedId, source: "imdb", label: "IMDb", value: 8, votes: 200, maxValue: 10, url: "https://example.test/imdb" },
	]);

	await db.insert(schema.metadataLockedFields).values([
		{ metadataId: relatedId, field: "title" },
		{ metadataId: relatedId, field: "overview" },
	]);

	return { relatedId, bareId };
}

describe("metadata relations", () => {
	test("detail returns every relation the title was seeded with", async () => {
		const { relatedId } = await seedTitles();
		const detail = await metadataRepository.findById({ primaryId: relatedId });
		if (!detail) throw new Error("seeded title not found");

		expect(detail.genres.map((genre) => genre.name).toSorted()).toEqual(["Drama", "Thriller"]);
		expect(detail.keywords.map((keyword) => keyword.name)).toEqual(["heist"]);
		expect(detail.collections.map((collection) => collection.name)).toEqual(["Saga"]);
		expect(detail.companies.map((company) => company.name).toSorted()).toEqual(["Studio A", "Studio B"]);
		expect(detail.providers.map((provider) => provider.name)).toEqual(["TMDB"]);
		expect(detail.cast.map((credit) => credit.role)).toEqual(["Lead", "Support"]);
		expect(detail.crew.map((credit) => credit.job)).toEqual(["Director"]);
		expect(detail.images.map((image) => image.imageType).toSorted()).toEqual(["backdrop", "poster"]);
		expect(detail.rating.scores).toHaveLength(2);
		expect(detail.lockedFields.toSorted()).toEqual(["overview", "title"]);
	});

	test("default detail projection and explicit field projection return identical relations", async () => {
		const { relatedId } = await seedTitles();
		const detail = await metadataRepository.findById({ primaryId: relatedId });
		const projected = await metadataRepository.findById({
			primaryId: relatedId,
			fields: QueryFields.parse({ fields: RELATION_KEYS.join(",") }),
		});
		if (!(detail && projected)) throw new Error("seeded title not found");

		expect(pickRelations(projected)).toEqual(pickRelations(detail));
	});

	test("list page relations match the detail relations for the same title", async () => {
		const { relatedId } = await seedTitles();
		const detail = await metadataRepository.findById({ primaryId: relatedId });
		const page = await metadataRepository.findPage({ limit: 10 });
		const listed = page.data.find((item) => item.id === relatedId);
		if (!(detail && listed)) throw new Error("seeded title not found in list or detail");

		expect(listed.genres).toEqual(detail.genres);
		expect(listed.images).toEqual(detail.images);
		expect(listed.rating.scores).toEqual(detail.rating.scores);
	});

	test("a title with no relations returns empty relation payloads", async () => {
		const { bareId } = await seedTitles();
		const bare = await metadataRepository.findById({ primaryId: bareId });
		if (!bare) throw new Error("bare title not found");

		expect(pickRelations(bare)).toEqual({
			collections: [],
			companies: [],
			genres: [],
			keywords: [],
			cast: [],
			crew: [],
			images: [],
			rating: expect.objectContaining({ scores: [] }),
			providers: [],
			lockedFields: [],
		});
	});
});
