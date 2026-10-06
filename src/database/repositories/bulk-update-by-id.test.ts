import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { databaseFactory } from "@/database/database";
import { episodesRepository } from "./episodes.repository";
import { seasonsRepository } from "./seasons.repository";

// Covers the chunked CASE writes used by the provider season/episode sync.
// Foreign keys are disabled for the file so parent rows are not required when
// the ambient database is migrated (the stub tables have no FK constraints).
const sqlite = databaseFactory.sqlite;

beforeAll(() => {
	sqlite.run("PRAGMA foreign_keys = OFF");
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS seasons (
			id TEXT PRIMARY KEY,
			stable_key TEXT NOT NULL,
			metadata_id TEXT NOT NULL,
			image_id TEXT,
			season_number INTEGER NOT NULL,
			name TEXT,
			overview TEXT,
			air_date TEXT,
			status TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS episodes (
			id TEXT PRIMARY KEY,
			stable_key TEXT NOT NULL,
			season_id TEXT NOT NULL,
			image_id TEXT,
			type TEXT NOT NULL DEFAULT 'regular',
			episode_number INTEGER NOT NULL,
			absolute_number INTEGER,
			title TEXT,
			overview TEXT,
			air_date TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
});

afterAll(() => {
	sqlite.run("PRAGMA foreign_keys = ON");
});

beforeEach(() => {
	sqlite.run("DELETE FROM episodes");
	sqlite.run("DELETE FROM seasons");
});

function insertSeason(id: string, values: { name?: string | null; overview?: string | null } = {}): void {
	const now = Math.floor(Date.now() / 1000);
	sqlite.run(
		"INSERT INTO seasons (id, stable_key, metadata_id, season_number, name, overview, created_at, updated_at) VALUES (?, ?, 'meta-1', 1, ?, ?, ?, ?)",
		[id, id, values.name ?? null, values.overview ?? null, now, now],
	);
}

function insertEpisode(id: string, values: { title?: string | null; absoluteNumber?: number | null } = {}): void {
	const now = Math.floor(Date.now() / 1000);
	sqlite.run(
		"INSERT INTO episodes (id, stable_key, season_id, type, episode_number, absolute_number, title, created_at, updated_at) VALUES (?, ?, 's-1', 'regular', 1, ?, ?, ?, ?)",
		[id, id, values.absoluteNumber ?? null, values.title ?? null, now, now],
	);
}

describe("seasonsRepository.updateManyFields", () => {
	test("assigns per-row fields and keeps omitted ones", async () => {
		insertSeason("s-1", { name: "old", overview: "old" });
		insertSeason("s-2", { name: "old", overview: "old" });

		await seasonsRepository.updateManyFields([
			{ id: "s-1", values: { name: "new", overview: "new ov" } },
			{ id: "s-2", values: { status: "returning" } },
		]);

		const rows = sqlite.query("SELECT id, name, overview, status FROM seasons ORDER BY id").all();
		expect(rows).toEqual([
			{ id: "s-1", name: "new", overview: "new ov", status: null },
			{ id: "s-2", name: "old", overview: "old", status: "returning" },
		]);
	});

	test("applies explicit nulls and ignores an empty update list", async () => {
		insertSeason("s-1", { name: "old", overview: "old" });

		await seasonsRepository.updateManyFields([{ id: "s-1", values: { overview: null } }]);
		await seasonsRepository.updateManyFields([]);

		const rows = sqlite.query("SELECT id, name, overview FROM seasons").all();
		expect(rows).toEqual([{ id: "s-1", name: "old", overview: null }]);
	});
});

describe("episodesRepository.updateManyFields", () => {
	test("assigns per-row fields and keeps omitted ones", async () => {
		insertEpisode("e-1", { title: "old", absoluteNumber: 5 });
		insertEpisode("e-2", { title: "old", absoluteNumber: 7 });

		await episodesRepository.updateManyFields([
			{ id: "e-1", values: { title: "new" } },
			{ id: "e-2", values: { absoluteNumber: null } },
		]);

		const rows = sqlite.query("SELECT id, title, absolute_number FROM episodes ORDER BY id").all();
		expect(rows).toEqual([
			{ id: "e-1", title: "new", absolute_number: 5 },
			{ id: "e-2", title: "old", absolute_number: null },
		]);
	});
});
