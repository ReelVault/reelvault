import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { DatabaseFactory, databaseFactory } from "@/database/database";
import { createProviderStableKey } from "@/database/utils/stable-key";
import { metadataPersistenceRepository } from "./metadata-persistence.repository";

const tempDirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Routes every singleton repository call into the isolated factory for this test. */
function redirectSingleton(factory: DatabaseFactory): void {
	spies.push(
		spyOn(databaseFactory, "transaction").mockImplementation((callback, options) => factory.transaction(callback, options)),
		spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)),
	);
}

function providerResult(): ProviderMetadataResult {
	return {
		externalId: "550",
		title: "Same Title",
		releaseDate: "2020-01-01",
		popularity: 10,
	};
}

describe("metadataPersistenceRepository.rematchProviderMetadata", () => {
	test("merges a conflicting duplicate without cascading its media files away", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "rv-rematch-"));
		tempDirs.push(tempDir);
		const factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
		factory.migrate();
		redirectSingleton(factory);

		try {
			const db = factory.sqlite;
			const now = Math.floor(Date.now() / 1000);
			db.run(
				"INSERT INTO libraries (id, name, type, metadata_storage_mode, sidecar_flavor, metadata_language, created_at, updated_at) VALUES (?,?,?,?,?,NULL,?,?)",
				["lib-1", "Movies", "movies", "database", "reelvault", now, now],
			);
			const insertMetadata = db.prepare(
				"INSERT INTO metadata (id, stable_key, title, original_title, type, status, release_date, popularity, created_at, updated_at) VALUES (?,?,?,?,?,'released',?,0,?,?)",
			);
			insertMetadata.run("m-target", "target-key", "Same Title", "Same Title", "movie", "2020-01-01", now, now);
			// The duplicate carries the provider stable key the rematch is about to
			// claim — that (not the title) is the conflict the query matches.
			insertMetadata.run(
				"m-dupe",
				createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "550" }),
				"Same Title (duplicate)",
				"Same Title (duplicate)",
				"movie",
				"2020-01-01",
				now,
				now,
			);
			db.run("INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES (?,?,?,?,?)", [
				"movie-dupe",
				"movie-dupe",
				"m-dupe",
				now,
				now,
			]);
			db.run(
				"INSERT INTO media_files (id, library_id, metadata_id, movie_id, episode_id, file_path, file_name, is_default, is_enabled, created_at, updated_at) VALUES (?,?,?,?,NULL,?,?,0,1,?,?)",
				["file-1", "lib-1", "m-dupe", "movie-dupe", "/media/movie.mkv", "movie.mkv", now, now],
			);

			await metadataPersistenceRepository.rematchProviderMetadata({
				metadataId: "m-target",
				type: "movie",
				providerName: "tmdb",
				metadata: providerResult(),
			});

			const mediaFile = db.query("SELECT metadata_id AS metadataId, movie_id AS movieId FROM media_files WHERE id = 'file-1'").get() as {
				metadataId: string;
				movieId: string;
			};
			expect(mediaFile.metadataId).toBe("m-target");
			expect(mediaFile.movieId).not.toBeNull();

			const movie = db.query("SELECT metadata_id AS metadataId FROM movies WHERE id = ?").get(mediaFile.movieId) as { metadataId: string };
			expect(movie.metadataId).toBe("m-target");

			expect(db.query("SELECT COUNT(*) AS count FROM metadata WHERE id = 'm-dupe'").get()).toEqual({ count: 0 });
			expect(db.query("SELECT COUNT(*) AS count FROM movies WHERE id = 'movie-dupe'").get()).toEqual({ count: 0 });
		} finally {
			factory.shutdown();
		}
	});
});
