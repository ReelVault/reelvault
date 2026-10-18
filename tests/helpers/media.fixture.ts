import { and, eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { useTestDatabase } from "./test-database.helper";

type TestClient = ReturnType<ReturnType<typeof useTestDatabase>["client"]>;

function first<T>(rows: T[]): T {
	const row = rows[0];
	if (!row) throw new Error("Expected the insert to return a row");

	return row;
}

/**
 * Inserts a movie library (reused when it exists) with one movie (metadata id `metadataId`) and one media file at `filePath`;
 * returns the media file id. Call it once per metadata id in a test.
 */
export async function insertMovieMediaFile(client: TestClient, filePath: string, metadataId = "movie-1"): Promise<string> {
	// One movie library is shared by every call in the test; (name, type) is unique.
	const [existingLibrary] = await client
		.select({ id: schema.libraries.id })
		.from(schema.libraries)
		.where(and(eq(schema.libraries.name, "Movies"), eq(schema.libraries.type, "movies")));
	const library =
		existingLibrary ??
		first(await client.insert(schema.libraries).values({ name: "Movies", type: "movies" }).returning({ id: schema.libraries.id }));
	const metadata = first(
		await client
			.insert(schema.metadata)
			.values({ id: metadataId, stableKey: metadataId, title: metadataId, type: "movie", releaseDate: "2020-01-01" })
			.returning({ id: schema.metadata.id }),
	);
	const movie = first(
		await client.insert(schema.movies).values({ stableKey: metadataId, metadataId: metadata.id }).returning({ id: schema.movies.id }),
	);
	const mediaFile = first(
		await client
			.insert(schema.mediaFiles)
			.values({
				libraryId: library.id,
				metadataId: metadata.id,
				movieId: movie.id,
				filePath,
				fileName: filePath.slice(filePath.lastIndexOf("/") + 1),
			})
			.returning({ id: schema.mediaFiles.id }),
	);

	return mediaFile.id;
}
