import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { CanonicalSidecarDocument } from "@/modules/metadata-sidecars/sidecar.types";
import { insertMetadataRow } from "./catalog-importer.utils";
import { CatalogSchemaBuilder } from "./catalog-schema.builder";

const NOW = 1_700_000_000_000;

async function createDatabase(): Promise<Database> {
	const database = new Database(":memory:");
	await new CatalogSchemaBuilder().createSchema(database);

	return database;
}

function movieDocument(fields: Partial<CanonicalSidecarDocument>): CanonicalSidecarDocument {
	return { mediaKind: "movie", identifiers: {}, artwork: {}, title: "Offline Movie", ...fields };
}

function storedReleaseDate(database: Database, id: string): string | undefined {
	return database.query<{ release_date: string }, [string]>("SELECT release_date FROM metadata WHERE id = ?").get(id)?.release_date;
}

describe("insertMetadataRow", () => {
	test("stores an empty release date when the document has neither a full date nor a year", async () => {
		const database = await createDatabase();
		insertMetadataRow(database, { id: "movie-1", type: "movie", document: movieDocument({}), now: NOW });

		expect(storedReleaseDate(database, "movie-1")).toBe("");
	});

	test("derives the release date from the year when the document has no full date", async () => {
		const database = await createDatabase();
		insertMetadataRow(database, { id: "movie-2", type: "movie", document: movieDocument({ year: 1999 }), now: NOW });

		expect(storedReleaseDate(database, "movie-2")).toBe("1999-01-01");
	});

	test("keeps the full release date the document names", async () => {
		const database = await createDatabase();
		insertMetadataRow(database, {
			id: "movie-3",
			type: "movie",
			document: movieDocument({ year: 1999, releaseDate: "1999-05-14" }),
			now: NOW,
		});

		expect(storedReleaseDate(database, "movie-3")).toBe("1999-05-14");
	});
});
