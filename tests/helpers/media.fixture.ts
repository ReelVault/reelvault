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

/**
 * Inserts a series linked to provider `tmdb` (external id "1") with season 1, episode 1 and its media file, in a TV
 * library that uses `metadataLanguage`; returns the ids. The episode starts with the title "Pilot".
 */
export async function insertSeriesEpisode(
	client: TestClient,
	metadataLanguage: string | null,
): Promise<{ metadataId: string; seasonId: string; episodeId: string }> {
	const library = first(
		await client
			.insert(schema.libraries)
			.values({ name: "Series", type: "tv_shows", metadataLanguage })
			.returning({ id: schema.libraries.id }),
	);
	const metadata = first(
		await client
			.insert(schema.metadata)
			.values({ id: "show-1", stableKey: "show-1", title: "Show", type: "tv_show", releaseDate: "2020-01-01" })
			.returning({ id: schema.metadata.id }),
	);
	const provider = first(
		await client
			.insert(schema.providers)
			.values({ stableKey: "tmdb-tv-1", name: "tmdb", entityType: "tv_show", externalId: "1" })
			.returning({ id: schema.providers.id }),
	);
	await client.insert(schema.metadataProviders).values({ metadataId: metadata.id, providerId: provider.id });
	const season = first(
		await client
			.insert(schema.seasons)
			.values({ stableKey: "show-1-s1", metadataId: metadata.id, seasonNumber: 1 })
			.returning({ id: schema.seasons.id }),
	);
	const episode = first(
		await client
			.insert(schema.episodes)
			.values({ stableKey: "show-1-s1e1", seasonId: season.id, episodeNumber: 1, title: "Pilot" })
			.returning({ id: schema.episodes.id }),
	);
	await client.insert(schema.mediaFiles).values({
		libraryId: library.id,
		metadataId: metadata.id,
		episodeId: episode.id,
		filePath: "/tv/show/s01e01.mkv",
		fileName: "s01e01.mkv",
	});

	return { metadataId: metadata.id, seasonId: season.id, episodeId: episode.id };
}
