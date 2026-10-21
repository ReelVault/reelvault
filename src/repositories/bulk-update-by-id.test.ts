import { beforeEach, describe, expect, test } from "bun:test";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { episodesRepository } from "./episodes.repository";
import { seasonsRepository } from "./seasons.repository";

// Covers the chunked CASE writes used by the provider season/episode sync.
// Foreign keys are off for the file so an episode can be written without its
// parent season row. Every test gets its own migrated database, so the stub
// tables the file used to create in the shared database are gone: the real
// schema applies, unique indexes included.
const { sqlite } = useTestDatabase();

beforeEach(() => {
	sqlite().run("PRAGMA foreign_keys = OFF");
});

function insertSeason(id: string, seasonNumber: number, values: { name?: string | null; overview?: string | null } = {}): void {
	const now = Math.floor(Date.now() / 1000);
	sqlite().run(
		"INSERT INTO seasons (id, stable_key, metadata_id, season_number, name, overview, created_at, updated_at) VALUES (?, ?, 'meta-1', ?, ?, ?, ?, ?)",
		[id, id, seasonNumber, values.name ?? null, values.overview ?? null, now, now],
	);
}

function insertEpisode(id: string, episodeNumber: number, values: { title?: string | null; absoluteNumber?: number | null } = {}): void {
	const now = Math.floor(Date.now() / 1000);
	sqlite().run(
		"INSERT INTO episodes (id, stable_key, season_id, type, episode_number, absolute_number, title, created_at, updated_at) VALUES (?, ?, 's-1', 'regular', ?, ?, ?, ?, ?)",
		[id, id, episodeNumber, values.absoluteNumber ?? null, values.title ?? null, now, now],
	);
}

describe("seasonsRepository.updateManyFields", () => {
	test("assigns per-row fields and keeps omitted ones", async () => {
		insertSeason("s-1", 1, { name: "old", overview: "old" });
		insertSeason("s-2", 2, { name: "old", overview: "old" });

		await seasonsRepository.updateManyFields([
			{ id: "s-1", values: { name: "new", overview: "new ov" } },
			{ id: "s-2", values: { status: "returning" } },
		]);

		const rows = sqlite().query("SELECT id, name, overview, status FROM seasons ORDER BY id").all();
		expect(rows).toEqual([
			{ id: "s-1", name: "new", overview: "new ov", status: null },
			{ id: "s-2", name: "old", overview: "old", status: "returning" },
		]);
	});

	test("applies explicit nulls and ignores an empty update list", async () => {
		insertSeason("s-1", 1, { name: "old", overview: "old" });

		await seasonsRepository.updateManyFields([{ id: "s-1", values: { overview: null } }]);
		await seasonsRepository.updateManyFields([]);

		const rows = sqlite().query("SELECT id, name, overview FROM seasons").all();
		expect(rows).toEqual([{ id: "s-1", name: "old", overview: null }]);
	});
});

describe("episodesRepository.updateManyFields", () => {
	test("assigns per-row episode fields and keeps omitted ones", async () => {
		insertEpisode("e-1", 1, { title: "old", absoluteNumber: 5 });
		insertEpisode("e-2", 2, { title: "old", absoluteNumber: 7 });

		await episodesRepository.updateManyFields([
			{ id: "e-1", values: { title: "new" } },
			{ id: "e-2", values: { absoluteNumber: null } },
		]);

		const rows = sqlite().query("SELECT id, title, absolute_number FROM episodes ORDER BY id").all();
		expect(rows).toEqual([
			{ id: "e-1", title: "new", absolute_number: 5 },
			{ id: "e-2", title: "old", absolute_number: null },
		]);
	});
});
