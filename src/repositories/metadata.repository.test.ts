import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { removeTreeSync } from "@/utils/directory.utils";
import { calculateAverageScore } from "./metadata/rating-aggregation.utils";
import { metadataRepository } from "./metadata.repository";

describe("metadata rating projections", () => {
	test("ignores missing rating rows produced by partial relation projections", () => {
		expect(calculateAverageScore([undefined, { value: 8, maxValue: 10 }, null, { value: 4, maxValue: 5 }])).toBe(8);
	});

	test("returns undefined when the relation contains no valid ratings", () => {
		expect(calculateAverageScore([undefined, null])).toBeUndefined();
	});

	test("weights each source by its vote count so a high-volume source dominates", () => {
		const weighted = calculateAverageScore([
			{ value: 5.7, maxValue: 10, votes: 61557 },
			{ value: 52, maxValue: 100, votes: 0 },
			{ value: 47, maxValue: 100, votes: 0 },
		]);

		// Ratings on a ten-point scale: 5.7, 5.2 and 4.7. A source with votes weighs 1 + log10(1 + votes); one without votes weighs 1.
		// (5.7 * (1 + log10(61558)) + 5.2 + 4.7) / ((1 + log10(61558)) + 2) = 5.5074, which rounds to 5.51.
		expect(weighted).toBe(5.51);
	});

	test("simple strategy averages every source equally", () => {
		const simple = calculateAverageScore(
			[
				{ value: 5.7, maxValue: 10, votes: 61557 },
				{ value: 52, maxValue: 100, votes: 0 },
				{ value: 47, maxValue: 100, votes: 0 },
			],
			"simple",
		);

		expect(simple).toBe(5.2);
	});
});

describe("metadata orphan cleanup and similar titles", () => {
	test("deleteOrphansByIds returns 0 for empty array", async () => {
		const count = await metadataRepository.deleteOrphansByIds([]);
		expect(count).toBe(0);
	});

	test("deleteOrphansByIds skips rows that gained a media file and reports actual changes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "reelvault-orphans-test-"));
		const factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
		try {
			factory.migrate();
			const db = factory.sqlite;
			const now = Math.floor(Date.now() / 1000);
			db.run(
				"INSERT INTO libraries (id, name, type, metadata_storage_mode, sidecar_flavor, metadata_language, created_at, updated_at) VALUES ('lib-1','Movies','movies','database','reelvault',NULL,?,?)",
				[now, now],
			);
			const insertMetadata = db.prepare(
				"INSERT INTO metadata (id, stable_key, title, original_title, type, status, release_date, popularity, created_at, updated_at) VALUES (?,?,?,?,?,'released','2020-01-01',0,?,?)",
			);
			insertMetadata.run("m-orphan", "m-orphan", "Orphan", "Orphan", "movie", now, now);
			insertMetadata.run("m-attached", "m-attached", "Attached", "Attached", "movie", now, now);
			db.run("INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES ('movie-1','movie-1','m-attached',?,?)", [
				now,
				now,
			]);
			db.run(
				"INSERT INTO media_files (id, library_id, metadata_id, movie_id, episode_id, file_path, file_name, is_default, is_enabled, created_at, updated_at) VALUES ('f1','lib-1','m-attached','movie-1',NULL,'/media/a.mkv','a.mkv',0,1,?,?)",
				[now, now],
			);

			const deleted = await metadataRepository.deleteOrphansByIds(["m-orphan", "m-attached"], factory.db);

			expect(deleted).toBe(1);
			expect(db.query("SELECT id FROM metadata ORDER BY id").all()).toEqual([{ id: "m-attached" }]);
			// The keyset page never returns the attached row.
			expect(await metadataRepository.findOrphanIds(10, undefined, factory.db)).toEqual([]);
		} finally {
			factory.shutdown();
			removeTreeSync(tempDir);
		}
	});
});

describe("metadata similar titles from the stored source", () => {
	test("getMoreLikeThis loads the source traits itself and keeps only titles sharing one", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "reelvault-similar-source-test-"));
		const factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
		try {
			factory.migrate();
			const db = factory.sqlite;
			const now = Math.floor(Date.now() / 1000);

			const insertMetadata = db.prepare(
				"INSERT INTO metadata (id, stable_key, title, original_title, overview, tagline, type, status, release_date, origin_country, popularity, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 'movie', NULL, '2020-01-01', NULL, 0, ?, ?)",
			);
			for (const id of ["m-a", "m-b", "m-c"]) insertMetadata.run(id, id, id.toUpperCase(), id.toUpperCase(), now, now);

			const insertGenre = db.prepare("INSERT INTO genres (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
			insertGenre.run("g-1", "g-1", "One", now, now);
			insertGenre.run("g-2", "g-2", "Two", now, now);

			const link = db.prepare("INSERT INTO metadata_genres (metadata_id, genre_id) VALUES (?, ?)");
			link.run("m-a", "g-1");
			link.run("m-b", "g-1");
			link.run("m-c", "g-2");

			// No `source` passed: the loader must read m-a's traits itself.
			const result = await metadataRepository.getMoreLikeThis({ metadataId: "m-a", limit: 10, offset: 0, tx: factory.db });

			expect(result.data.map((row) => row.id)).toEqual(["m-b"]);
			expect(result.total).toBe(1);
		} finally {
			factory.shutdown();
			removeTreeSync(tempDir);
		}
	});

	test("counts collection and director bonuses once, while summing genre and cast matches", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "reelvault-similar-bonus-test-"));
		const factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
		try {
			factory.migrate();
			const db = factory.sqlite;
			const now = Math.floor(Date.now() / 1000);

			const insertMetadata = db.prepare(
				"INSERT INTO metadata (id, stable_key, title, original_title, overview, tagline, type, status, release_date, origin_country, popularity, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 'movie', NULL, '2020-01-01', NULL, 0, ?, ?)",
			);
			for (const id of ["m-source", "m-genre-cast", "z-one", "a-two", "z-two", "a-one"]) {
				insertMetadata.run(id, id, id, id, now, now);
			}

			const insertCollection = db.prepare("INSERT INTO collections (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
			insertCollection.run("c-1", "c-1", "One", now, now);
			insertCollection.run("c-2", "c-2", "Two", now, now);
			db.prepare("INSERT INTO genres (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
				"g-1",
				"g-1",
				"Genre",
				now,
				now,
			);
			const insertPerson = db.prepare("INSERT INTO people (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
			for (const person of ["p-1", "p-2", "d-1", "d-2"]) {
				insertPerson.run(person, person, person, now, now);
			}

			const linkCollection = db.prepare("INSERT INTO metadata_collections (metadata_id, collection_id, sort_order) VALUES (?, ?, ?)");
			for (const [metadataId, collectionId] of [
				["m-source", "c-1"],
				["m-source", "c-2"],
				["z-one", "c-1"],
				["a-two", "c-1"],
				["z-two", "c-1"],
				["z-two", "c-2"],
				["a-one", "c-1"],
			] as const) {
				linkCollection.run(metadataId, collectionId, 0);
			}
			db.prepare("INSERT INTO metadata_genres (metadata_id, genre_id) VALUES (?, ?)").run("m-source", "g-1");
			db.prepare("INSERT INTO metadata_genres (metadata_id, genre_id) VALUES (?, ?)").run("m-genre-cast", "g-1");

			const linkCast = db.prepare("INSERT INTO metadata_cast (metadata_id, person_id, role, sort_order) VALUES (?, ?, 'Actor', ?)");
			linkCast.run("m-source", "p-1", 0);
			linkCast.run("m-source", "p-2", 1);
			linkCast.run("m-genre-cast", "p-1", 0);

			const linkCrew = db.prepare(
				"INSERT INTO metadata_crew (metadata_id, person_id, job, department) VALUES (?, ?, 'Director', 'Directing')",
			);
			linkCrew.run("m-source", "d-1");
			linkCrew.run("m-source", "d-2");
			linkCrew.run("z-one", "d-1");
			linkCrew.run("a-two", "d-1");
			linkCrew.run("a-two", "d-2");

			const result = await metadataRepository.getMoreLikeThis({ metadataId: "m-source", limit: 10, offset: 0, tx: factory.db });

			expect(result.data.map((row) => row.id)).toEqual(["m-genre-cast", "z-one", "a-two", "z-two", "a-one"]);
			expect(result.total).toBe(5);
		} finally {
			factory.shutdown();
			removeTreeSync(tempDir);
		}
	});
});

describe("provider-neutral similar titles", () => {
	test("credits crew by how informative the job is and cast by billing, whatever the provider calls them", async () => {
		// Its own source id: the ranked page cache is keyed by source id and outlives each test's database.
		const tempDir = mkdtempSync(join(tmpdir(), "reelvault-similar-neutral-test-"));
		const factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
		try {
			factory.migrate();
			const db = factory.sqlite;
			const now = Math.floor(Date.now() / 1000);

			const insertMetadata = db.prepare(
				"INSERT INTO metadata (id, stable_key, title, original_title, overview, tagline, type, status, release_date, origin_country, popularity, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 'movie', NULL, '2020-01-01', NULL, 0, ?, ?)",
			);
			for (const id of ["neutral-source", "m-director", "m-assistant", "m-actor"]) insertMetadata.run(id, id, id, id, now, now);
			const insertPerson = db.prepare("INSERT INTO people (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
			for (const person of ["director", "actor", "a-0", "a-1", "a-2", "a-3", "a-4", "a-5", "a-6", "a-7"]) {
				insertPerson.run(person, person, person, now, now);
			}

			// A provider naming jobs in Polish: every title has one "Reżyseria" credit and a crowd of five "Asystent" credits.
			const linkCrew = db.prepare("INSERT INTO metadata_crew (metadata_id, person_id, job, department) VALUES (?, ?, ?, 'Crew')");
			linkCrew.run("neutral-source", "director", "Reżyseria");
			linkCrew.run("m-director", "director", "Reżyseria");
			// m-assistant swaps the roles: the source's assistant a-0 directs it, and the source's director assists on it.
			linkCrew.run("m-assistant", "a-0", "Reżyseria");
			linkCrew.run("m-actor", "a-6", "Reżyseria");
			for (const [metadataId, people] of [
				["neutral-source", ["a-0", "a-1", "a-2", "a-3", "a-4"]],
				["m-director", ["a-1", "a-2", "a-3", "a-4", "a-5"]],
				["m-assistant", ["director", "a-1", "a-2", "a-3", "a-4"]],
				["m-actor", ["a-2", "a-3", "a-4", "a-5", "a-6"]],
			] as const) {
				for (const person of people) linkCrew.run(metadataId, person, "Asystent");
			}
			// TMDB stores the department as the cast role, so "Acting" is a real value.
			const linkCast = db.prepare("INSERT INTO metadata_cast (metadata_id, person_id, role, sort_order) VALUES (?, ?, 'Acting', ?)");
			linkCast.run("neutral-source", "actor", 0);
			linkCast.run("m-actor", "actor", 0);

			const result = await metadataRepository.getMoreLikeThis({ metadataId: "neutral-source", limit: 10, offset: 0, tx: factory.db });

			// Shared director: 80 × 1. Shared lead actor: 15. A person shared through the crowded job (weight 0.2)
			// on either side is no trait, so m-assistant does not appear.
			expect(result.data.map((row) => row.id)).toEqual(["m-director", "m-actor"]);
		} finally {
			factory.shutdown();
			removeTreeSync(tempDir);
		}
	});
});
