import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MetadataRefreshDependencies, MetadataRefreshService } from "@/application/catalog/metadata/metadata-refresh.service";

process.env.NODE_ENV ??= "test";
process.env.APP_PORT ??= "3030";
process.env.ROOT_DIR ??= join(tmpdir(), `reelvault-tests-${process.pid}`);

function createDependencies(): MetadataRefreshDependencies {
	return {
		findMetadata: async () => ({
			id: "metadata-1",
			type: "movie",
			providers: [
				{ name: "offline-provider", externalId: "offline-1" },
				{ name: "active-provider", externalId: "external-1" },
			],
		}),
		fetchProviderDetails: async (providerId, _type, externalId) =>
			providerId === "active-provider" ? { externalId, title: " Provider title ", releaseDate: "2024-01-01", popularity: 11 } : undefined,
		transformMetadata: async (candidate) => ({ ...candidate, title: "Plugin title" }),
		updateMetadata: async () => undefined,
		publishRefreshed: () => undefined,
	};
}

describe("metadata refresh service", () => {
	test("refreshes from a linked provider, runs the hook and publishes after persistence", async () => {
		const calls: string[] = [];
		const dependencies = createDependencies();
		dependencies.fetchProviderDetails = (providerId, _type, externalId) => {
			calls.push(`fetch:${providerId}`);

			return Promise.resolve(
				providerId === "active-provider" ? { externalId, title: " Provider title ", releaseDate: "2024-01-01", popularity: 11 } : undefined,
			);
		};
		dependencies.transformMetadata = (candidate) => {
			calls.push("hook");
			expect(candidate).toMatchObject({
				type: "movie",
				title: " Provider title ",
				identity: { providerId: "active-provider", externalId: "external-1" },
			});

			return Promise.resolve({ ...candidate, title: "Plugin title" });
		};
		dependencies.updateMetadata = (metadataId, values) => {
			calls.push("update");
			expect(metadataId).toBe("metadata-1");
			expect(values).toEqual({
				title: "Plugin title",
				originalTitle: undefined,
				overview: undefined,
				tagline: undefined,
				releaseDate: "2024-01-01",
				status: undefined,
				budget: undefined,
				revenue: undefined,
				popularity: 11,
				hasMissingTranslation: false,
			});

			return Promise.resolve();
		};
		dependencies.publishRefreshed = (metadataId, correlationId) => {
			calls.push(`event:${metadataId}:${correlationId}`);
		};

		await expect(new MetadataRefreshService(dependencies).refresh("metadata-1", { correlationId: "refresh-job-1" })).resolves.toEqual({
			metadataId: "metadata-1",
			providerId: "active-provider",
		});
		expect(calls).toEqual(["fetch:active-provider", "fetch:offline-provider", "hook", "update", "event:metadata-1:refresh-job-1"]);
	});

	test("keeps current metadata without emitting an event when no linked provider can refresh", async () => {
		const dependencies = createDependencies();
		const published: string[] = [];
		dependencies.publishRefreshed = (metadataId) => published.push(metadataId);
		const updateCalls: string[] = [];
		dependencies.updateMetadata = (metadataId) => {
			updateCalls.push(metadataId);

			return Promise.resolve();
		};

		// All providers unreachable (outage / rate limit) is an expected anomaly:
		// the refresh is skipped with a warn instead of failing the job.
		await expect(
			new MetadataRefreshService({
				...dependencies,
				fetchProviderDetails: async () => undefined,
			}).refresh("metadata-1"),
		).resolves.toEqual({ metadataId: "metadata-1", providerId: "" });
		expect(updateCalls).toEqual([]);
		expect(published).toEqual([]);
	});

	test("prefers the persisted primary provider without changing it on fallback", async () => {
		const calls: string[] = [];
		const dependencies = createDependencies();
		dependencies.findMetadata = async () => ({
			id: "metadata-1",
			type: "movie",
			primaryProviderId: "active-provider",
			providers: [
				{ name: "offline-provider", externalId: "offline-1" },
				{ name: "active-provider", externalId: "external-1" },
			],
		});
		dependencies.fetchProviderDetails = (providerId, _type, externalId) => {
			calls.push(providerId);

			return Promise.resolve(
				providerId === "active-provider" ? { externalId, title: "Active title", releaseDate: "2024-01-01" } : undefined,
			);
		};

		const result = await new MetadataRefreshService(dependencies).refresh("metadata-1");

		expect(calls).toEqual(["active-provider", "offline-provider"]);
		expect(result.providerId).toBe("active-provider");
	});

	test("enqueues metadata, person and tv season/episode images when present", async () => {
		const enqueued: unknown[] = [];
		const dependencies = createDependencies();
		dependencies.findMetadata = async () => ({
			id: "tv-1",
			type: "tv_show",
			providers: [{ name: "active-provider", externalId: "tv-ext-1" }],
		});
		dependencies.fetchProviderDetails = async () => ({
			externalId: "tv-ext-1",
			title: "TV Show",
			releaseDate: "2024-01-01",
			posterPath: "/poster.jpg",
			backdropPath: "/backdrop.jpg",
			cast: [{ id: "p1", name: "Actor", profilePath: "/actor.jpg", role: "Actor", character: "Character", order: 0 }],
		});
		dependencies.syncCredits = async () => [{ personId: "person-1", url: "/actor.jpg" }];
		dependencies.syncSeasonsAndEpisodes = async () => [
			{ kind: "season", metadataId: "tv-1", seasonId: "s-1", seasonNumber: "1", urls: "/season1.jpg" },
			{ kind: "episode", metadataId: "tv-1", episodeId: "ep-1", seasonNumber: "1", episodeNumber: "1", urls: "/ep1.jpg" },
		];
		dependencies.enqueueImages = (data, options) => {
			enqueued.push({ data, options });

			return Promise.resolve();
		};

		await new MetadataRefreshService(dependencies).refresh("tv-1", { correlationId: "corr-123" });

		expect(enqueued).toEqual([
			{
				data: {
					kind: "metadata",
					metadataId: "tv-1",
					urls: [
						{ type: "poster", url: "/poster.jpg" },
						{ type: "backdrop", url: "/backdrop.jpg" },
					],
				},
				options: { operationId: "corr-123" },
			},
			{
				data: { kind: "person", personId: "person-1", urls: "/actor.jpg" },
				options: { operationId: "corr-123" },
			},
			{
				data: { kind: "season", metadataId: "tv-1", seasonId: "s-1", seasonNumber: "1", urls: "/season1.jpg" },
				options: { operationId: "corr-123" },
			},
			{
				data: { kind: "episode", metadataId: "tv-1", episodeId: "ep-1", seasonNumber: "1", episodeNumber: "1", urls: "/ep1.jpg" },
				options: { operationId: "corr-123" },
			},
		]);
	});

	test("prioritizes operationId over correlationId when enqueuing child images", async () => {
		const enqueued: unknown[] = [];
		const dependencies = createDependencies();
		dependencies.findMetadata = async () => ({
			id: "movie-1",
			type: "movie",
			providers: [{ name: "active-provider", externalId: "m-ext-1" }],
		});
		dependencies.fetchProviderDetails = async () => ({
			externalId: "m-ext-1",
			title: "Movie",
			releaseDate: "2024-01-01",
			posterPath: "/poster.jpg",
		});
		dependencies.enqueueImages = (data, options) => {
			enqueued.push({ data, options });

			return Promise.resolve();
		};

		await new MetadataRefreshService(dependencies).refresh("movie-1", {
			correlationId: "corr-old",
			operationId: "op-explicit-123",
		});

		expect(enqueued).toEqual([
			{
				data: {
					kind: "metadata",
					metadataId: "movie-1",
					urls: [{ type: "poster", url: "/poster.jpg" }],
				},
				options: { operationId: "op-explicit-123" },
			},
		]);
	});

	test("preserves locked fields and skips locked relation updates during refresh", async () => {
		const dependencies = createDependencies();
		let updatedValues: Record<string, unknown> | undefined;
		let syncedRelationsLocked: readonly string[] | undefined;
		let syncedCreditsLocked: readonly string[] | undefined;
		const enqueued: unknown[] = [];

		dependencies.getLockedFields = () => Promise.resolve(["title", "overview", "genres", "cast", "images"]);
		dependencies.fetchProviderDetails = async () => ({
			externalId: "external-1",
			title: "Overwritten Title",
			overview: "Overwritten Overview",
			tagline: "New Tagline",
			releaseDate: "2024-05-05",
			popularity: 42,
			posterPath: "/new-poster.jpg",
		});
		dependencies.transformMetadata = (candidate) => Promise.resolve(candidate);
		dependencies.updateMetadata = (_id, values) => {
			updatedValues = values;

			return Promise.resolve();
		};
		dependencies.syncMetadataRelations = (_id, _provider, _meta, locked) => {
			syncedRelationsLocked = locked;

			return Promise.resolve();
		};
		dependencies.syncCredits = (_id, _provider, _meta, locked) => {
			syncedCreditsLocked = locked;

			return Promise.resolve([]);
		};
		dependencies.enqueueImages = (data) => {
			enqueued.push(data);

			return Promise.resolve();
		};

		await new MetadataRefreshService(dependencies).refresh("metadata-1");

		expect(updatedValues).toEqual({
			originalTitle: undefined,
			tagline: "New Tagline",
			releaseDate: "2024-05-05",
			status: undefined,
			budget: undefined,
			revenue: undefined,
			popularity: 42,
			hasMissingTranslation: false,
		});
		expect(syncedRelationsLocked).toEqual(["title", "overview", "genres", "cast", "images"]);
		expect(syncedCreditsLocked).toEqual(["title", "overview", "genres", "cast", "images"]);
		expect(enqueued).toEqual([]);
	});

	test("throws immediately when signal is already aborted", async () => {
		const dependencies = createDependencies();
		const controller = new AbortController();
		controller.abort();

		await expect(
			new MetadataRefreshService(dependencies).refresh("movie-1", {
				signal: controller.signal,
			}),
		).rejects.toThrow();
	});
});
