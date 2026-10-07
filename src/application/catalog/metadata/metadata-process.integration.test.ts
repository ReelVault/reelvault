import { afterEach, beforeEach, expect, test } from "bun:test";
import { collectionRepository } from "@/database/repositories/collections.repository";
import { companiesRepository } from "@/database/repositories/companies.repository";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { genreRepository } from "@/database/repositories/genres.repository";
import { keywordsRepository } from "@/database/repositories/keywords.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { moviesRepository } from "@/database/repositories/movies.repository";
import { peopleRepository } from "@/database/repositories/people.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { providerService } from "@/plugins/capabilities/provider.service";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { pluginHookBus } from "@/plugins/runtime/plugin.hooks";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { MetadataProcess } from "./metadata-process";

const calls: string[] = [];
const enqueuedImages: Array<{ kind: string; urls?: unknown }> = [];
let persistedTitle: string | undefined;
const eventHandlers = new Map<string, Set<(payload: { pluginId?: string }) => void | Promise<void>>>();

let providerAggregated: unknown = {
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
let identifierRows: Array<Record<string, unknown>> = [];
let localMetadataRow: Record<string, unknown> | undefined;
let providerLinkRow: Record<string, unknown> | undefined;
let seasonRow: Record<string, unknown> | undefined;
let episodeRow: Record<string, unknown> | undefined;
const seasonValues: Array<Record<string, unknown>> = [];
const episodeValues: Array<Record<string, unknown>> = [];

async function emitEvent(event: string, payload: { pluginId?: string }): Promise<void> {
	for (const handler of eventHandlers.get(event) ?? []) await handler(payload);
}

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	activeStubs.push(
		stubMethod(providerService, "fetchAggregatedDetails", async () => providerAggregated),
		stubMethod(providerService, "fetchSeasonFromLinks", async () => []),
		stubMethod(providerService, "fetchEpisodeFromLinks", async () => []),
		stubMethod(pluginHookBus, "runBeforeMetadataSave", (candidate: { title: string }) => {
			calls.push("hook");

			return Promise.resolve({ ...candidate, title: "Normalized title" });
		}),
		stubMethod(pluginEventBus, "publish", (event: string, payload: { metadataId?: string; pluginId?: string }) => {
			if (event === "metadata.saved" && payload.metadataId) calls.push(`event:${payload.metadataId}`);

			emitEvent(event, payload).catch(() => undefined);
		}),
		stubMethod(metadataRepository, "findOrCreateMetadata", ({ results }: { results: { title: string } }) => {
			calls.push("persist");
			persistedTitle = results.title;

			return Promise.resolve({ created: true, metadata: { id: "metadata-1" } });
		}),
		stubMethod(metadataRepository, "findByTitleAndType", async () => localMetadataRow),
		stubMethod(metadataRepository, "findByProviderExternalIds", async () => identifierRows),
		stubMethod(metadataRepository, "findFirstProviderLink", async () => providerLinkRow),
		stubMethod(metadataRepository, "flagMissingTranslation", async () => undefined),
		stubMethod(metadataRepository, "insertRatings", async () => undefined),
		stubMethod(collectionRepository, "process", async () => undefined),
		stubMethod(companiesRepository, "process", async () => undefined),
		stubMethod(genreRepository, "process", async () => undefined),
		stubMethod(keywordsRepository, "process", async () => undefined),
		stubMethod(peopleRepository, "processMetadataCredits", async () =>
			Array.from({ length: 30 }, (_, index) => ({ personId: `person-${index}`, url: `https://images.test/${index}.jpg` })),
		),
		stubMethod(moviesRepository, "findOrCreateByMetadataId", () => {
			calls.push("movie");

			return Promise.resolve({ id: "movie-1" });
		}),
		stubMethod(seasonsRepository, "findByMetadataAndNumber", async () => seasonRow),
		stubMethod(seasonsRepository, "findOrCreateByIdentity", (input: { values?: Record<string, unknown> }) => {
			calls.push("season");
			seasonValues.push(input.values ?? {});

			return Promise.resolve({ id: "season-1", stableKey: "season-stable" });
		}),
		stubMethod(episodesRepository, "findBySeasonAndNumber", async () => episodeRow),
		stubMethod(episodesRepository, "findOrCreateByIdentity", (input: { values?: Record<string, unknown> }) => {
			calls.push("episode");
			episodeValues.push(input.values ?? {});

			return Promise.resolve({ id: "episode-1" });
		}),
	);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

function resetSidecarState(): void {
	calls.splice(0);
	enqueuedImages.splice(0);
	persistedTitle = undefined;
	seasonValues.splice(0);
	episodeValues.splice(0);
	providerAggregated = {
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
	identifierRows = [];
	localMetadataRow = undefined;
	providerLinkRow = undefined;
	seasonRow = undefined;
	episodeRow = undefined;
}

test("imports provider metadata through the hook, persistence and post-save event boundary", async () => {
	resetSidecarState();

	await expect(
		new MetadataProcess((data) => {
			enqueuedImages.push(data);
			calls.push(`image:${data.kind}`);

			return Promise.resolve();
		}).checkMetadata({ type: "movie", parsed: { type: "movie", title: "Raw title" } }),
	).resolves.toEqual({
		metadataId: "metadata-1",
		movieId: "movie-1",
		episodeId: null,
	});

	expect(String(persistedTitle)).toBe("Normalized title");
	expect(calls.indexOf("movie")).toBeLessThan(calls.indexOf("image:metadata"));
	expect(enqueuedImages.filter((image) => image.kind === "person")).toHaveLength(25);
	expect(calls.at(-1)).toBe("event:metadata-1");
});

test("sidecar identifiers resolve an existing row without touching providers", async () => {
	resetSidecarState();
	identifierRows = [
		{ externalId: "tt123", metadata: { id: "metadata-9", title: "From DB", releaseDate: null, stableKey: "sk-9" }, fileCount: 0 },
	];

	await expect(
		new MetadataProcess((data) => {
			enqueuedImages.push(data);

			return Promise.resolve();
		}).checkMetadata({
			type: "movie",
			parsed: { type: "movie", title: "Filename garbage" },
			sidecar: { identifiers: { imdb: "tt123" }, title: "Sidecar title", year: 2020 },
		}),
	).resolves.toEqual({ metadataId: "metadata-9", movieId: "movie-1", episodeId: null });

	expect(calls).toContain("movie");
	expect(calls).not.toContain("persist");
});

test("creates metadata offline from the sidecar payload when providers find nothing", async () => {
	resetSidecarState();
	providerAggregated = null;

	await expect(
		new MetadataProcess((data) => {
			enqueuedImages.push(data);
			calls.push(`image:${data.kind}`);

			return Promise.resolve();
		}).checkMetadata({
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
	).resolves.toEqual({ metadataId: "metadata-1", movieId: "movie-1", episodeId: null });

	expect(persistedTitle).toBe("Normalized title");
	const metadataImages = enqueuedImages.find((image) => image.kind === "metadata");
	expect(metadataImages).toBeDefined();
	const urls = (metadataImages?.urls ?? []) as Array<{ type: string; url?: string }>;
	expect(urls.find((url) => url.type === "poster")?.url).toBe("/media/Backrooms/folder.jpg");
});

test("offline tv import synthesizes season and episode facts from the sidecar hint", async () => {
	resetSidecarState();
	providerAggregated = null;

	await expect(
		new MetadataProcess((data) => {
			enqueuedImages.push(data);
			calls.push(`image:${data.kind}`);

			return Promise.resolve();
		}).checkMetadata({
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
	).resolves.toEqual({ metadataId: "metadata-1", movieId: null, episodeId: "episode-1" });

	expect(seasonValues[0]?.name).toBe("Season One");
	expect(episodeValues[0]?.title).toBe("In Space, No One…");
	const seasonImages = enqueuedImages.find((image) => image.kind === "season");
	expect(seasonImages?.urls).toBe("/media/Alien/season01-poster.jpg");
	const episodeImages = enqueuedImages.find((image) => image.kind === "episode");
	const urls = episodeImages?.urls as string | undefined;
	expect(urls).toBe("/media/Alien/e03-thumb.jpg");
});

test("existing local tv show keeps the current file's sidecar episode title", async () => {
	resetSidecarState();
	providerAggregated = null;
	// A sibling episode already created the show, its season and a provider link —
	// the second episode resolves through the existing-local path, which must
	// still forward this file's sidecar hint or its title is dropped.
	localMetadataRow = { id: "metadata-1", title: "Alien: Earth", releaseDate: "2025-01-01", stableKey: "sk-1" };
	seasonRow = { id: "season-1", stableKey: "season-stable" };
	episodeRow = undefined;
	providerLinkRow = { name: "local", externalId: "local-1" };

	await expect(
		new MetadataProcess((data) => {
			enqueuedImages.push(data);
			calls.push(`image:${data.kind}`);

			return Promise.resolve();
		}).checkMetadata({
			type: "tv_show",
			parsed: { type: "tv_show", title: "filename", season: 1, episode: 4 },
			sidecar: {
				identifiers: {},
				title: "Alien: Earth",
				year: 2025,
				seasonName: "Season One",
				episodeName: "The Long Dark",
			},
		}),
	).resolves.toEqual({ metadataId: "metadata-1", movieId: null, episodeId: "episode-1" });

	expect(episodeValues[0]?.title).toBe("The Long Dark");
});
