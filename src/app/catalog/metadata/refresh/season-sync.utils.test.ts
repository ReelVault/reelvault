import { describe, expect, test } from "bun:test";
import type { ProviderEpisodeResult, ProviderSeasonResult } from "@reelvault/sdk/plugin";
import { insertEpisodes, insertMetadata, insertSeasons, selectEpisodes, selectSeasons } from "../../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";
import { syncSeasonsAndEpisodes } from "./season-sync.utils";

// Seasons and episodes are seeded in the migrated test database and read back after the
// sync, so each assertion is about stored rows. Provider data is passed in as arguments.
const db = useTestDatabase();

/** A timestamp well before the sync: rows the sync leaves alone keep it, rows it writes get a fresh one. */
const SEEDED_AT = new Date("2026-01-01T00:00:00.000Z");

function season(number: number, overrides: Partial<ProviderSeasonResult> = {}): ProviderSeasonResult {
	return { externalId: `season-${number}`, seasonNumber: number, name: `Season ${number}`, ...overrides };
}

function episode(number: number, overrides: Partial<ProviderEpisodeResult> = {}): ProviderEpisodeResult {
	return { externalId: `episode-${number}`, seasonNumber: 1, episodeNumber: number, name: `Episode ${number}`, ...overrides };
}

async function seedShow(): Promise<string> {
	const [metadata] = await insertMetadata(db.client(), { stableKey: "show-1", title: "Show", type: "tv_show", releaseDate: "2020-01-01" });

	return metadata?.id ?? "";
}

async function seedSeason(metadataId: string, seasonNumber: number, values: { name: string; overview: string }): Promise<string> {
	const [row] = await insertSeasons(db.client(), {
		stableKey: `season-${seasonNumber}`,
		metadataId,
		seasonNumber,
		...values,
		createdAt: SEEDED_AT,
		updatedAt: SEEDED_AT,
	});

	return row?.id ?? "";
}

async function seedEpisode(seasonId: string, episodeNumber: number, title: string): Promise<string> {
	const [row] = await insertEpisodes(db.client(), {
		stableKey: `episode-${seasonId}-${episodeNumber}`,
		seasonId,
		episodeNumber,
		title,
		createdAt: SEEDED_AT,
		updatedAt: SEEDED_AT,
	});

	return row?.id ?? "";
}

async function storedSeasons() {
	return await selectSeasons(db.client());
}

async function storedEpisodes() {
	return await selectEpisodes(db.client());
}

describe("syncSeasonsAndEpisodes seasons", () => {
	test("updates the seasons whose fields changed and returns a poster task for each one with artwork", async () => {
		const metadataId = await seedShow();
		const changedId = await seedSeason(metadataId, 1, { name: "old", overview: "old" });
		const untouchedId = await seedSeason(metadataId, 2, { name: "Season 2", overview: "kept" });

		const tasks = await syncSeasonsAndEpisodes(metadataId, [season(1, { posterPath: "/posters/s1.jpg", overview: "new overview" })]);

		const rows = await storedSeasons();
		expect(rows.find((row) => row.id === changedId)).toMatchObject({ name: "Season 1", overview: "new overview" });
		expect(rows.find((row) => row.id === untouchedId)).toMatchObject({ name: "Season 2", overview: "kept" });
		expect(tasks).toEqual([{ kind: "season", metadataId, seasonId: changedId, seasonNumber: "1", urls: "/posters/s1.jpg" }]);
	});

	test("leaves a season whose fields are unchanged without a write", async () => {
		const metadataId = await seedShow();
		await seedSeason(metadataId, 1, { name: "Season 1", overview: "same" });

		const tasks = await syncSeasonsAndEpisodes(metadataId, [season(1, { overview: "same" })]);

		const [row] = await storedSeasons();
		expect(row?.updatedAt).toEqual(SEEDED_AT);
		expect(tasks).toEqual([]);
	});
});

describe("syncSeasonsAndEpisodes episodes", () => {
	test("updates only the episodes whose title changed and returns a thumbnail task for each one with artwork", async () => {
		const metadataId = await seedShow();
		const seasonId = await seedSeason(metadataId, 1, { name: "Season 1", overview: "" });
		const sameId = await seedEpisode(seasonId, 1, "Episode 1");
		const staleId = await seedEpisode(seasonId, 2, "stale");

		const tasks = await syncSeasonsAndEpisodes(metadataId, [
			season(1, { episodes: [episode(1), episode(2, { thumbnailPath: "/thumbs/e2.jpg" })] }),
		]);

		const rows = await storedEpisodes();
		expect(rows.find((row) => row.id === staleId)).toMatchObject({ title: "Episode 2" });
		expect(rows.find((row) => row.id === sameId)?.updatedAt).toEqual(SEEDED_AT);
		expect(tasks).toEqual([
			{ kind: "episode", metadataId, episodeId: staleId, seasonNumber: "1", episodeNumber: "2", urls: "/thumbs/e2.jpg" },
		]);
	});

	test("fetches the episodes of a season the provider listed without any and syncs them", async () => {
		const metadataId = await seedShow();
		const seasonId = await seedSeason(metadataId, 1, { name: "Season 1", overview: "" });
		const episodeId = await seedEpisode(seasonId, 1, "stale");
		const fetched: number[] = [];

		const tasks = await syncSeasonsAndEpisodes(metadataId, [season(1)], (seasonNumber) => {
			fetched.push(seasonNumber);

			return Promise.resolve([episode(1, { thumbnailPath: "/thumbs/e1.jpg" })]);
		});

		expect(fetched).toEqual([1]);
		expect(await storedEpisodes()).toEqual([expect.objectContaining({ id: episodeId, title: "Episode 1" })]);
		expect(tasks).toEqual([{ kind: "episode", metadataId, episodeId, seasonNumber: "1", episodeNumber: "1", urls: "/thumbs/e1.jpg" }]);
	});

	test("a failing episode fetch leaves its season as it is and the other seasons still sync", async () => {
		const metadataId = await seedShow();
		const failingSeasonId = await seedSeason(metadataId, 1, { name: "Season 1", overview: "" });
		const healthySeasonId = await seedSeason(metadataId, 2, { name: "Season 2", overview: "" });
		const failingEpisodeId = await seedEpisode(failingSeasonId, 1, "untouched");
		const healthyEpisodeId = await seedEpisode(healthySeasonId, 1, "stale");

		const tasks = await syncSeasonsAndEpisodes(
			metadataId,
			[season(1), season(2, { episodes: [episode(1, { seasonNumber: 2 })] })],
			(seasonNumber) => (seasonNumber === 1 ? Promise.reject(new Error("provider exploded")) : Promise.resolve(undefined)),
		);

		const rows = await storedEpisodes();
		expect(rows.find((row) => row.id === failingEpisodeId)).toMatchObject({ title: "untouched" });
		expect(rows.find((row) => row.id === healthyEpisodeId)).toMatchObject({ title: "Episode 1" });
		expect(tasks).toEqual([]);
	});
});
