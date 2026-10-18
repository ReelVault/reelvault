import { describe, expect, test } from "bun:test";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";

const db = useTestDatabase();

/** Two movies (`movie-1`, `movie-2`) and one episode (`episode-1`), all in `lib-1`. */
async function seedTargets(): Promise<void> {
	const client = db.client();
	await client.insert(schema.libraries).values({ id: "lib-1", name: "Library", type: "movies" });
	await client.insert(schema.metadata).values([
		{ id: "meta-movie-1", stableKey: "movie-1", title: "Heat", type: "movie", releaseDate: "1995-12-15" },
		{ id: "meta-movie-2", stableKey: "movie-2", title: "Ronin", type: "movie", releaseDate: "1998-09-24" },
		{ id: "meta-show", stableKey: "show", title: "Show", type: "tv_show", releaseDate: "2000-01-01" },
	]);
	await client.insert(schema.movies).values([
		{ id: "movie-1", stableKey: "movie-1", metadataId: "meta-movie-1" },
		{ id: "movie-2", stableKey: "movie-2", metadataId: "meta-movie-2" },
	]);
	await client.insert(schema.seasons).values({ id: "season-1", stableKey: "show-s1", metadataId: "meta-show", seasonNumber: 1 });
	await client.insert(schema.episodes).values({ id: "episode-1", stableKey: "show-s1e1", seasonId: "season-1", episodeNumber: 1 });
}

async function insertMovieFile(id: string, movieId: "movie-1" | "movie-2", isDefault = false): Promise<void> {
	await db
		.client()
		.insert(schema.mediaFiles)
		.values({
			id,
			libraryId: "lib-1",
			metadataId: movieId === "movie-1" ? "meta-movie-1" : "meta-movie-2",
			movieId,
			fileName: `${id}.mkv`,
			filePath: `/media/${id}.mkv`,
			size: 1_000,
			duration: 3_600,
			isDefault,
		});
}

async function insertEpisodeFile(id: string, isDefault = false): Promise<void> {
	await db
		.client()
		.insert(schema.mediaFiles)
		.values({
			id,
			libraryId: "lib-1",
			metadataId: "meta-show",
			episodeId: "episode-1",
			fileName: `${id}.mkv`,
			filePath: `/tv/${id}.mkv`,
			size: 1_000,
			duration: 1_500,
			isDefault,
		});
}

async function defaultFlags(): Promise<Record<string, boolean>> {
	const rows = await db.client().select({ id: schema.mediaFiles.id, isDefault: schema.mediaFiles.isDefault }).from(schema.mediaFiles);

	return Object.fromEntries(rows.map((row) => [row.id, row.isDefault]));
}

describe("mediaRepository.setDefault", () => {
	test("moves the default flag to another file of the same movie", async () => {
		await seedTargets();
		await insertMovieFile("mf-a", "movie-1", true);
		await insertMovieFile("mf-b", "movie-1");

		await mediaRepository.setDefault("mf-b", true, db.client());

		expect(await defaultFlags()).toEqual({ "mf-a": false, "mf-b": true });
	});

	test("moves the default flag between files of the same episode", async () => {
		await seedTargets();
		await insertEpisodeFile("ep-a", true);
		await insertEpisodeFile("ep-b");

		await mediaRepository.setDefault("ep-b", true, db.client());

		expect(await defaultFlags()).toEqual({ "ep-a": false, "ep-b": true });
	});

	test("leaves the default file of another movie untouched", async () => {
		await seedTargets();
		await insertMovieFile("mf-a", "movie-1", true);
		await insertMovieFile("mf-b", "movie-1");
		await insertMovieFile("mf-c", "movie-2", true);

		await mediaRepository.setDefault("mf-b", true, db.client());

		expect(await defaultFlags()).toEqual({ "mf-a": false, "mf-b": true, "mf-c": true });
	});

	test("unsetting a non-default file leaves the current default in place", async () => {
		await seedTargets();
		await insertMovieFile("mf-a", "movie-1", true);
		await insertMovieFile("mf-b", "movie-1");

		await mediaRepository.setDefault("mf-b", false, db.client());

		expect(await defaultFlags()).toEqual({ "mf-a": true, "mf-b": false });
	});

	test("changes nothing when the media file does not exist", async () => {
		await seedTargets();
		await insertMovieFile("mf-a", "movie-1", true);

		await mediaRepository.setDefault("mf-missing", true, db.client());

		expect(await defaultFlags()).toEqual({ "mf-a": true });
	});
});
