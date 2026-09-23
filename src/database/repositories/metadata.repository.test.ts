import { describe, expect, test } from "bun:test";
import { metadataRepository } from "./metadata.repository";
import { calculateAverageScore } from "./metadata-recommendations";

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

		expect(weighted).toBeGreaterThan(5.4);
		expect(weighted).toBeLessThan(5.7);
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

	test("deleteOrphansByIds returns 0 for empty array", async () => {
		const count = await metadataRepository.deleteOrphansByIds([]);
		expect(count).toBe(0);
	});

	test("getMoreLikeThis executes valid SQL without parameterizing table names", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { DatabaseFactory } = await import("@/database/database");

		const tempDir = mkdtempSync(join(tmpdir(), "reelvault-similar-test-"));
		const factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
		try {
			factory.migrate();

			const result = await metadataRepository.getMoreLikeThis({
				metadataId: "01a08314-8c09-7075-a96b-9242e1bc758a",
				source: {
					type: "tv_show",
					collections: [{ id: "01a08314-88e2-74d2-8bfc-9d26d5e60348" }],
					genres: [{ id: "01a08314-88e2-74d2-8bfc-9d26d5e60348" }],
					keywords: [{ id: "01a08314-88ca-723e-b44d-b74f5370ca95" }],
					crew: [{ job: "Director", data: { id: "00235c46-6d7d-5219-b7d5-783eab30b222" } }],
					cast: [{ role: "Actor", data: { id: "01a08314-8a78-7162-996e-142706a67fb8" }, sortOrder: 0 }],
				},
				limit: 20,
				offset: 0,
				tx: factory.db,
			});

			expect(result).toEqual({ total: 0, data: [] });
		} finally {
			factory.shutdown();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("getMoreLikeThis loads the source traits itself and keeps only titles sharing one", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { DatabaseFactory } = await import("@/database/database");

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
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
