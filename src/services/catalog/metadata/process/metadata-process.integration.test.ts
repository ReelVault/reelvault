import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { providerService } from "@/plugins/capabilities/provider.service";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { pluginHookBus } from "@/system/extensions/plugin.hooks";
import type { ImageProcessingData } from "@/workers/definitions/images/image-processing.worker";
import { type MethodStub, stubMethod } from "../../../../../tests/helpers/method-stub.helper";
import { selectEpisodes, selectMetadata, selectMovies, selectSeasons } from "../../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";
import { MetadataProcess } from "./metadata-process.service";

// Imports persist to the migrated test database. Only the external providers, the
// plugin hook/event buses and the image worker queue are stubbed.
const db = useTestDatabase();
const stubs: MethodStub[] = [];

let providerAggregated: unknown;
let namedMatch: unknown;
let seasonLinks: unknown[] = [];
let episodeLinks: unknown[] = [];
const namedLookups: string[] = [];
const titleSearches: string[] = [];
const episodeRequests: number[] = [];

const defaultAggregated = {
	primaryProviderId: "test-provider",
	metadata: {
		externalId: "external-1",
		title: "Raw title",
		releaseDate: "2024-01-01",
		posterPath: "https://images.test/poster.jpg",
	},
	providers: [{ providerId: "test-provider", externalId: "external-1" }],
	matchScore: 1,
};

beforeEach(() => {
	providerAggregated = defaultAggregated;
	namedMatch = undefined;
	seasonLinks = [];
	episodeLinks = [];
	namedLookups.splice(0);
	titleSearches.splice(0);
	episodeRequests.splice(0);

	stubs.push(
		stubMethod(providerService, "fetchAggregatedDetails", () => {
			titleSearches.push("search");

			return Promise.resolve(providerAggregated);
		}),
		stubMethod(providerService, "fetchAggregatedDetailsByProvider", (_providerId: string, _type: string, externalId: string) => {
			namedLookups.push(externalId);

			return Promise.resolve(namedMatch);
		}),
		stubMethod(providerService, "fetchSeasonFromLinks", () => Promise.resolve(seasonLinks)),
		stubMethod(providerService, "fetchEpisodeFromLinks", (_links: unknown, _season: number, episodeNumber: number) => {
			episodeRequests.push(episodeNumber);

			return Promise.resolve(episodeLinks);
		}),
	);
});

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function importer(enqueued: ImageProcessingData[] = []): MetadataProcess {
	return new MetadataProcess((data) => {
		enqueued.push(data);

		return Promise.resolve();
	});
}

async function storedTitles(): Promise<string[]> {
	const rows = await selectMetadata(db.client());

	return rows.map((row) => row.title).toSorted();
}

describe("MetadataProcess provider lookup", () => {
	test("a TMDB id from the sidecar fetches that title before any title search", async () => {
		namedMatch = {
			primaryProviderId: "tmdb",
			metadata: { externalId: "329", title: "Jurassic Park", releaseDate: "1993-06-11" },
			providers: [{ providerId: "tmdb", externalId: "329" }],
			matchScore: 1,
		};

		const result = await importer().checkMetadata({
			type: "movie",
			parsed: { type: "movie", title: "Jurassic Park", year: 1993 },
			sidecar: { identifiers: { tmdb: "329" } },
		});

		expect(namedLookups).toEqual(["329"]);
		expect(titleSearches).toEqual([]);
		expect(result?.metadataId).toEqual(expect.any(String));
		expect(await storedTitles()).toEqual(["Jurassic Park"]);
	});

	test("an id the provider does not know falls back to the title search", async () => {
		const result = await importer().checkMetadata({
			type: "movie",
			parsed: { type: "movie", title: "Jurassic Park", year: 1993 },
			sidecar: { identifiers: { tmdb: "999" } },
		});

		expect(namedLookups).toEqual(["999"]);
		expect(titleSearches).toEqual(["search"]);
		expect(await storedTitles()).toEqual(["Raw title"]);
		expect(result?.metadataId).toEqual(expect.any(String));
	});

	test("a sidecar identifier resolves the row an earlier import created, without touching providers", async () => {
		providerAggregated = {
			primaryProviderId: "imdb",
			metadata: { externalId: "tt123", title: "Known film", releaseDate: "2020-01-01" },
			providers: [{ providerId: "imdb", externalId: "tt123" }],
			matchScore: 1,
		};
		const first = await importer().checkMetadata({ type: "movie", parsed: { type: "movie", title: "Known film" } });
		namedLookups.splice(0);
		titleSearches.splice(0);

		const second = await importer().checkMetadata({
			type: "movie",
			parsed: { type: "movie", title: "Filename garbage" },
			sidecar: { identifiers: { imdb: "tt123" }, title: "Sidecar title", year: 2020 },
		});

		expect(second).toEqual(first);
		expect(titleSearches).toEqual([]);
		expect(namedLookups).toEqual([]);
		expect(await storedTitles()).toEqual(["Known film"]);
	});
});

describe("MetadataProcess persistence and side effects", () => {
	test("persists the hook's title, creates the movie, queues artwork and publishes metadata.saved after the row exists", async () => {
		// Each published event checks, at publish time, that its metadata row is already stored.
		const rowsAtPublish: Array<Promise<number>> = [];
		stubs.push(
			stubMethod(pluginHookBus, "runBeforeMetadataSave", (candidate: { title: string }) =>
				Promise.resolve({ ...candidate, title: "Normalized title" }),
			),
			stubMethod(pluginEventBus, "publish", (event: string, payload: { metadataId?: string }) => {
				if (event !== "metadata.saved" || !payload.metadataId) return;
				rowsAtPublish.push(selectMetadata(db.client()).then((rows) => rows.filter((row) => row.id === payload.metadataId).length));
			}),
		);
		providerAggregated = {
			...defaultAggregated,
			metadata: {
				...defaultAggregated.metadata,
				cast: Array.from({ length: 30 }, (_, index) => ({
					id: `person-${index}`,
					name: `Person ${index}`,
					role: "Actor",
					profilePath: `https://images.test/${index}.jpg`,
				})),
			},
		};
		const enqueued: ImageProcessingData[] = [];

		const result = await importer(enqueued).checkMetadata({ type: "movie", parsed: { type: "movie", title: "Raw title" } });

		expect(result).toEqual({ metadataId: expect.any(String), movieId: expect.any(String), episodeId: null });
		expect(await storedTitles()).toEqual(["Normalized title"]);
		expect(await selectMovies(db.client())).toHaveLength(1);
		expect(rowsAtPublish).toHaveLength(1);
		expect(await Promise.all(rowsAtPublish)).toEqual([1]);
		expect(enqueued.filter((image) => image.kind === "person")).toHaveLength(25);
	});

	test("creates metadata offline from the sidecar payload when providers find nothing", async () => {
		providerAggregated = null;
		const enqueued: ImageProcessingData[] = [];

		await expect(
			importer(enqueued).checkMetadata({
				type: "movie",
				parsed: { type: "movie", title: "Backrooms.2026" },
				sidecar: {
					identifiers: { imdb: "tt999", tmdb: "42" },
					title: "Backrooms",
					year: 2026,
					releaseDate: "2026-01-15",
					posterPath: "/media/Backrooms/folder.jpg",
					genres: ["Horror", "Mystery"],
				},
			}),
		).resolves.toEqual({ metadataId: expect.any(String), movieId: expect.any(String), episodeId: null });

		expect(await storedTitles()).toEqual(["Backrooms"]);
		const metadataImages = enqueued.find((image) => image.kind === "metadata");
		const urls = (metadataImages?.urls ?? []) as Array<{ type: string; url?: string }>;
		expect(urls.find((url) => url.type === "poster")?.url).toBe("/media/Backrooms/folder.jpg");
	});
});

describe("MetadataProcess tv imports", () => {
	test("offline tv import stores the season and episode named by the sidecar and queues their artwork", async () => {
		providerAggregated = null;
		const enqueued: ImageProcessingData[] = [];

		await expect(
			importer(enqueued).checkMetadata({
				type: "tv_show",
				parsed: { type: "tv_show", title: "filename", season: 1, episode: 3 },
				sidecar: {
					identifiers: { tmdb: "777" },
					title: "Alien: Earth",
					year: 2025,
					seasonName: "Season One",
					seasonPosterPath: "/media/Alien/season01-poster.jpg",
					episodeName: "In Space, No One…",
					episodeThumbnailPath: "/media/Alien/e03-thumb.jpg",
				},
			}),
		).resolves.toEqual({ metadataId: expect.any(String), movieId: null, episodeId: expect.any(String) });

		const [season] = await selectSeasons(db.client());
		const [episode] = await selectEpisodes(db.client());
		expect(season?.name).toBe("Season One");
		expect(episode?.title).toBe("In Space, No One…");
		expect(enqueued.find((image) => image.kind === "season")?.urls).toBe("/media/Alien/season01-poster.jpg");
		expect(enqueued.find((image) => image.kind === "episode")?.urls).toBe("/media/Alien/e03-thumb.jpg");
	});

	test("a second episode of a local show keeps its own sidecar episode title", async () => {
		providerAggregated = null;
		await importer().checkMetadata({
			type: "tv_show",
			parsed: { type: "tv_show", title: "filename", season: 1, episode: 3 },
			sidecar: { identifiers: {}, title: "Alien: Earth", year: 2025, seasonName: "Season One", episodeName: "In Space" },
		});

		await importer().checkMetadata({
			type: "tv_show",
			parsed: { type: "tv_show", title: "filename", season: 1, episode: 4 },
			sidecar: { identifiers: {}, title: "Alien: Earth", year: 2025, seasonName: "Season One", episodeName: "The Long Dark" },
		});

		expect(await storedTitles()).toEqual(["Alien: Earth"]);
		const titles = (await selectEpisodes(db.client())).map((row) => ({ title: row.title, number: row.episodeNumber }));
		expect(titles.toSorted((a, b) => a.number - b.number)).toEqual([
			{ title: "In Space", number: 3 },
			{ title: "The Long Dark", number: 4 },
		]);
	});

	test("the single-episode endpoint supplies the overview when the season listing omits it", async () => {
		providerAggregated = {
			primaryProviderId: "test-provider",
			metadata: { externalId: "show-1", title: "Show", releaseDate: "2025-01-01" },
			providers: [{ providerId: "test-provider", externalId: "show-1" }],
			matchScore: 1,
		};
		seasonLinks = [
			{
				providerId: "test-provider",
				metadata: {
					externalId: "season-1",
					seasonNumber: 1,
					name: "Season One",
					episodes: [{ externalId: "episode-3", seasonNumber: 1, episodeNumber: 3, name: "Listed without overview" }],
				},
			},
		];
		episodeLinks = [
			{
				providerId: "test-provider",
				metadata: {
					externalId: "episode-3",
					seasonNumber: 1,
					episodeNumber: 3,
					name: "Listed without overview",
					overview: "The full overview from the single-episode endpoint",
				},
			},
		];

		await importer().checkMetadata({
			type: "tv_show",
			parsed: { type: "tv_show", title: "filename", season: 1, episode: 3 },
		});

		expect(episodeRequests).toEqual([3]);
		const [episode] = await selectEpisodes(db.client());
		expect(episode?.overview).toBe("The full overview from the single-episode endpoint");
	});
});
