import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProviderEpisodeResult, ProviderSeasonResult } from "@reelvault/sdk/plugin";
import type { episodesRepository } from "@/database/repositories/episodes.repository";
import type { seasonsRepository } from "@/database/repositories/seasons.repository";

/** Replaces a method on the live singleton for one test, recording calls.
 * Works on real repositories AND on the minimal facades other test files
 * install with bun's process-global mock.module(...). */
function stubMethod(target: object, method: string, impl: (...args: never[]) => unknown): { calls: unknown[][]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: unknown[][] = [];
	const replacement = (...args: never[]) => {
		calls.push(args);

		return impl(...args);
	};
	Reflect.set(target, method, replacement);

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

const seasonUpdates: unknown[][] = [];
const episodeUpdates: unknown[][] = [];
const seasonDeleteStubs: Array<{ restore(): void }> = [];
const episodeDeleteStubs: Array<{ restore(): void }> = [];
const activeStubs: Array<{ restore(): void }> = [];

beforeEach(async () => {
	seasonUpdates.length = 0;
	episodeUpdates.length = 0;

	const seasons = await import("@/database/repositories/seasons.repository");
	const seasonsRepo = seasons.seasonsRepository;
	activeStubs.push(
		stubMethod(seasonsRepo, "findByMetadataId", () => Promise.resolve([])),
		stubMethod(seasonsRepo, "update", (...args: never[]) => {
			seasonUpdates.push(args);

			return Promise.resolve(undefined);
		}),
	);
	seasonDeleteStubs.length = 0;

	const episodes = await import("@/database/repositories/episodes.repository");
	const episodesRepo = episodes.episodesRepository;
	activeStubs.push(
		stubMethod(episodesRepo, "findBySeasonIds", () => Promise.resolve([])),
		stubMethod(episodesRepo, "update", (...args: never[]) => {
			episodeUpdates.push(args);

			return Promise.resolve(undefined);
		}),
	);
	episodeDeleteStubs.length = 0;
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

type ExistingSeason = Awaited<ReturnType<typeof seasonsRepository.findByMetadataId>>[number];
type ExistingEpisode = Awaited<ReturnType<typeof episodesRepository.findBySeasonIds>>[number];

function season(number: string | number, overrides: Partial<ProviderSeasonResult> = {}): ProviderSeasonResult {
	return { externalId: `season-${number}`, seasonNumber: number, name: `Season ${number}`, ...overrides };
}

function episode(number: string | number, overrides: Partial<ProviderEpisodeResult> = {}): ProviderEpisodeResult {
	return { externalId: `episode-${number}`, seasonNumber: 1, episodeNumber: number, name: `Episode ${number}`, ...overrides };
}

function existingSeason(id: string, seasonNumber: number): ExistingSeason {
	return {
		id,
		stableKey: `season-${seasonNumber}`,
		metadataId: "meta-1",
		imageId: null,
		seasonNumber,
		name: "old",
		overview: "old",
		airDate: null,
		status: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

function existingEpisode(id: string, seasonId: string, episodeNumber: number, title = "old"): ExistingEpisode {
	return {
		id,
		stableKey: `ep-${seasonId}-${episodeNumber}`,
		seasonId,
		imageId: null,
		episodeType: "regular",
		episodeNumber,
		title,
		overview: null,
		airDate: null,
		absoluteNumber: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

async function seasonSync() {
	const mod = await import("./season-sync.utils");

	return mod.syncSeasonsAndEpisodes;
}

describe("syncSeasonsAndEpisodes", () => {
	test("returns nothing when the provider payload has no seasons", async () => {
		const sync = await seasonSync();
		await expect(sync("meta-1", undefined)).resolves.toEqual([]);
		await expect(sync("meta-1", [])).resolves.toEqual([]);
		expect(seasonUpdates).toHaveLength(0);
	});

	test("returns nothing when the database holds no seasons for the metadata", async () => {
		const sync = await seasonSync();
		await expect(sync("meta-1", [season(1)])).resolves.toEqual([]);
		expect(seasonUpdates).toHaveLength(0);
	});

	test("updates matching seasons and emits season artwork tasks", async () => {
		const seasons = await import("@/database/repositories/seasons.repository");
		activeStubs.push(
			stubMethod(seasons.seasonsRepository, "findByMetadataId", () =>
				Promise.resolve([existingSeason("s-1", 1), existingSeason("s-2", 2)]),
			),
		);

		const sync = await seasonSync();
		const tasks = await sync("meta-1", [season(1, { posterPath: "/posters/s1.jpg", overview: "new overview" })]);

		expect(seasonUpdates).toHaveLength(1);
		expect(seasonUpdates[0]?.[0]).toMatchObject({ primaryId: "s-1" });
		expect(tasks).toEqual([{ kind: "season", metadataId: "meta-1", seasonId: "s-1", seasonNumber: "1", urls: "/posters/s1.jpg" }]);
	});

	test("skips seasons whose fields are unchanged", async () => {
		const seasons = await import("@/database/repositories/seasons.repository");
		activeStubs.push(stubMethod(seasons.seasonsRepository, "findByMetadataId", () => Promise.resolve([existingSeason("s-1", 1)])));

		const sync = await seasonSync();
		const tasks = await sync("meta-1", [season(1, { name: "old", overview: "old" })]);

		expect(seasonUpdates).toHaveLength(0);
		expect(tasks).toEqual([]);
	});

	test("updates only episodes whose fields actually changed", async () => {
		const seasons = await import("@/database/repositories/seasons.repository");
		const episodes = await import("@/database/repositories/episodes.repository");
		activeStubs.push(
			stubMethod(seasons.seasonsRepository, "findByMetadataId", () => Promise.resolve([existingSeason("s-1", 1)])),
			stubMethod(episodes.episodesRepository, "findBySeasonIds", () =>
				Promise.resolve([
					existingEpisode("e-1", "s-1", 1, "Episode 1"), // same title → no update
					existingEpisode("e-2", "s-1", 2, "stale"), // changed → update
				]),
			),
		);

		const sync = await seasonSync();
		const tasks = await sync("meta-1", [season(1, { episodes: [episode(1), episode(2, { thumbnailPath: "/thumbs/e2.jpg" })] })]);

		expect(episodeUpdates).toHaveLength(1);
		expect(episodeUpdates[0]?.[0]).toMatchObject({ primaryId: "e-2", values: { title: "Episode 2" } });
		expect(tasks).toEqual([
			{ kind: "episode", metadataId: "meta-1", episodeId: "e-2", seasonNumber: "1", episodeNumber: "2", urls: "/thumbs/e2.jpg" },
		]);
	});

	test("fetches missing episodes for seasons without provider episodes and still updates them", async () => {
		const seasons = await import("@/database/repositories/seasons.repository");
		const episodes = await import("@/database/repositories/episodes.repository");
		activeStubs.push(
			stubMethod(seasons.seasonsRepository, "findByMetadataId", () => Promise.resolve([existingSeason("s-1", 1)])),
			stubMethod(episodes.episodesRepository, "findBySeasonIds", () => Promise.resolve([existingEpisode("e-1", "s-1", 1, "stale")])),
		);

		const fetched: number[] = [];
		const sync = await seasonSync();
		const tasks = await sync("meta-1", [season(1)], (seasonNumber) => {
			fetched.push(seasonNumber);

			return Promise.resolve([episode(1, { thumbnailPath: "/thumbs/e1.jpg" })]);
		});

		expect(fetched).toEqual([1]);
		expect(episodeUpdates).toHaveLength(1);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({ kind: "episode", episodeId: "e-1", urls: "/thumbs/e1.jpg" });
	});

	test("skips the fetch fallback when the provider already embedded episodes", async () => {
		const seasons = await import("@/database/repositories/seasons.repository");
		const episodes = await import("@/database/repositories/episodes.repository");
		activeStubs.push(
			stubMethod(seasons.seasonsRepository, "findByMetadataId", () => Promise.resolve([existingSeason("s-1", 1)])),
			stubMethod(episodes.episodesRepository, "findBySeasonIds", () => Promise.resolve([existingEpisode("e-1", "s-1", 1, "Episode 1")])),
		);

		const sync = await seasonSync();
		await sync("meta-1", [season(1, { episodes: [episode(1)] })], () => Promise.reject(new Error("must not be called")));

		expect(episodeUpdates).toHaveLength(0);
	});

	test("survives a failing fetch for one season", async () => {
		const seasons = await import("@/database/repositories/seasons.repository");
		const episodes = await import("@/database/repositories/episodes.repository");
		activeStubs.push(
			stubMethod(seasons.seasonsRepository, "findByMetadataId", () => Promise.resolve([existingSeason("s-1", 1)])),
			stubMethod(episodes.episodesRepository, "findBySeasonIds", () => Promise.resolve([existingEpisode("e-1", "s-1", 1)])),
		);

		const sync = await seasonSync();
		await sync("meta-1", [season(1)], () => Promise.reject(new Error("provider exploded")));

		expect(episodeUpdates).toHaveLength(0);
	});
});
