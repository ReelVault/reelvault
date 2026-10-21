import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTreeSync } from "@/utils/directory.utils";
import { playbackRepository } from "./playback.repository";

let tempDir: string;
let factory: DatabaseFactory;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "rv-playback-"));
	factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
	factory.migrate();
	spies.push(spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)));
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	factory.shutdown();
	removeTreeSync(tempDir);
});

function firstRow<T>(rows: T[]): T {
	const [row] = rows;
	if (!row) throw new Error("insert returned no row");

	return row;
}

type ProgressInsert = typeof schema.playbackProgress.$inferInsert;

async function insertProgress(row: ProgressInsert) {
	await factory.getClient().insert(schema.playbackProgress).values(row);
}

async function insertMovieFile(name: string, refs: { libraryId: string; metadataId: string; movieId: string }): Promise<string> {
	const file = firstRow(
		await factory
			.getClient()
			.insert(schema.mediaFiles)
			.values({ ...refs, filePath: `/movies/${name}.mkv`, fileName: `${name}.mkv` })
			.returning({ id: schema.mediaFiles.id }),
	);

	return file.id;
}

/**
 * A movie with two files. The first was finished long ago and its progress row is
 * inserted first; the second is half-watched and was touched most recently.
 */
async function seedMovieWithFinishedAndResumedFiles() {
	const db = factory.getClient();
	const user = firstRow(
		await db
			.insert(schema.users)
			.values({ name: "Viewer", email: "viewer@example.test", emailVerified: true })
			.returning({ id: schema.users.id }),
	);
	const profile = firstRow(
		await db.insert(schema.profiles).values({ userId: user.id, name: "Viewer" }).returning({ id: schema.profiles.id }),
	);
	const library = firstRow(
		await db.insert(schema.libraries).values({ name: "Movies", type: "movies" }).returning({ id: schema.libraries.id }),
	);
	const metadata = firstRow(
		await db
			.insert(schema.metadata)
			.values({ stableKey: "movie", title: "Movie", type: "movie", releaseDate: "2001-01-01", overview: "Overview" })
			.returning({ id: schema.metadata.id }),
	);
	const movie = firstRow(
		await db.insert(schema.movies).values({ stableKey: "movie", metadataId: metadata.id }).returning({ id: schema.movies.id }),
	);
	const refs = { libraryId: library.id, metadataId: metadata.id, movieId: movie.id };

	const finishedFileId = await insertMovieFile("movie-finished", refs);
	const resumedFileId = await insertMovieFile("movie-resumed", refs);

	await insertProgress({
		profileId: profile.id,
		mediaFileId: finishedFileId,
		position: 100,
		duration: 100,
		completed: true,
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	});
	await insertProgress({
		profileId: profile.id,
		mediaFileId: resumedFileId,
		position: 50,
		duration: 100,
		completed: false,
		updatedAt: new Date("2026-02-01T00:00:00Z"),
	});

	return { metadataId: metadata.id, profileId: profile.id, finishedFileId, resumedFileId };
}

describe("playbackRepository.findProgressRows", () => {
	test("returns the most recently updated progress row first", async () => {
		const { metadataId, profileId, finishedFileId, resumedFileId } = await seedMovieWithFinishedAndResumedFiles();

		const rows = await playbackRepository.findProgressRows(metadataId, profileId);

		expect(rows.map((row) => row.mediaFileId)).toEqual([resumedFileId, finishedFileId]);
	});
});
