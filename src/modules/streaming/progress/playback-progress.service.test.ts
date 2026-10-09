import { describe, expect, test } from "bun:test";
import { discoverService } from "@/application/users/discover.service";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import type { PlaybackProgressUpdateEvent } from "./playback-progress.publisher";
import {
	type PlaybackProgressPublisherDependency,
	type PlaybackProgressRepo,
	PlaybackProgressService,
	type ProfileStreamPrefsRepo,
	type WatchedHistoryRepo,
	type WatchlistRepo,
} from "./playback-progress.service";

type ContinueWatchingRepoData = Awaited<ReturnType<PlaybackProgressRepo["findContinueWatchingData"]>>;
type SmartPlayBatchEntries = Awaited<ReturnType<PlaybackProgressRepo["findSmartPlayBatchData"]>>;

interface TestHarness {
	watchlistRemovals: string[];
	service: PlaybackProgressService;
	upserts: Array<Parameters<PlaybackProgressRepo["upsertProgress"]>[0]>;
	watchedSyncs: Array<Parameters<WatchedHistoryRepo["sync"]>[0]>;
	published: PlaybackProgressUpdateEvent[];
	resets: { file: string[]; metadata: string[]; dismissed: string[]; bulk: string[] };
	continueWatchingData: ContinueWatchingRepoData;
	prefsUpserts: Array<Parameters<ProfileStreamPrefsRepo["upsert"]>[0]>;
}

function createService(
	options: {
		watchlistedIds?: string[];
		existingProgress?:
			| { completed: boolean; position?: number | null; audioStreamIndex?: number | null; subtitleId?: string | null }
			| null
			| undefined;
		continueWatchingData?: ContinueWatchingRepoData;
		fileMetadataId?: string | null | undefined;
		smartPlayBatchData?: SmartPlayBatchEntries;
		smartPlayBatchFails?: boolean;
		unknownFileIds?: string[];
		autoRemoveWatched?: boolean;
	} = {},
): TestHarness {
	const upserts: Array<Parameters<PlaybackProgressRepo["upsertProgress"]>[0]> = [];
	const watchedSyncs: Array<Parameters<WatchedHistoryRepo["sync"]>[0]> = [];
	const published: PlaybackProgressUpdateEvent[] = [];
	const resets = { file: [] as string[], metadata: [] as string[], dismissed: [] as string[], bulk: [] as string[] };
	const watchlistRemovals: string[] = [];
	const continueWatchingData: ContinueWatchingRepoData = options.continueWatchingData ?? {
		progressRows: [],
		metadataList: [],
		mediaFiles: [],
		seasons: [],
		episodes: [],
		backdrops: [],
	};

	const playbackRepository: PlaybackProgressRepo = {
		findProgressUpdateData: () =>
			Promise.resolve({
				mediaFile: { id: "file-1", duration: 1000, metadataId: "meta-1" },
				existingProgress: options.existingProgress
					? {
							completed: options.existingProgress.completed,
							position: options.existingProgress.position ?? null,
							audioStreamIndex: options.existingProgress.audioStreamIndex ?? null,
							subtitleId: options.existingProgress.subtitleId ?? null,
						}
					: undefined,
			}),
		upsertProgress: (input) => {
			upserts.push(input);

			return Promise.resolve();
		},
		findMediaFileWithMetadata: () =>
			Promise.resolve(
				options.fileMetadataId === null
					? undefined
					: {
							id: "file-1",
							metadataId: options.fileMetadataId ?? "meta-1",
							movieId: null,
							episodeId: null,
						},
			),
		deleteProgress: (profileId: string, fileId: string) => {
			resets.file.push(`${profileId}:${fileId}`);

			return Promise.resolve();
		},
		deleteMetadataProgress: (profileId: string, metadataId: string) => {
			resets.metadata.push(`${profileId}:${metadataId}`);

			return Promise.resolve();
		},
		deleteProgressForFiles: (profileId: string, fileIds: readonly string[]) => {
			for (const fileId of fileIds) resets.bulk.push(`${profileId}:${fileId}`);

			return Promise.resolve();
		},
		findExistingMediaFileIds: (fileIds: readonly string[]) =>
			Promise.resolve(new Set(fileIds.filter((fileId) => !options.unknownFileIds?.includes(fileId)))),
		dismissContinueWatching: (profileId: string, metadataId: string) => {
			resets.dismissed.push(`${profileId}:${metadataId}`);

			return Promise.resolve();
		},
		findContinueWatchingData: () => Promise.resolve(continueWatchingData),
		findPlaybackProgressAndSmartPlayData: () =>
			Promise.resolve({
				metadata: { type: "movie", numberingMode: null },
				mediaFiles: [],
				progressRows: [],
				seasons: [],
				episodes: [],
			}),
		findSmartPlayData: () =>
			Promise.resolve({
				metadata: { type: "movie", numberingMode: null },
				mediaFiles: [],
				progress: [],
				seasons: [],
				episodes: [],
			}),
		findSmartPlayBatchData: () => {
			if (options.smartPlayBatchFails) return Promise.reject(new Error("batch repository failure"));

			return Promise.resolve(options.smartPlayBatchData ?? []);
		},
	};

	const watchedHistoryRepository: WatchedHistoryRepo = {
		sync: (input) => {
			watchedSyncs.push(input);

			return Promise.resolve();
		},
	};

	const publisher: PlaybackProgressPublisherDependency = {
		publishUpdate: (event: PlaybackProgressUpdateEvent) => {
			published.push(event);
		},
	};

	const prefsUpserts: Array<Parameters<ProfileStreamPrefsRepo["upsert"]>[0]> = [];
	const profileStreamPrefsRepository: ProfileStreamPrefsRepo = {
		upsert: (input) => {
			prefsUpserts.push(input);

			return Promise.resolve();
		},
		find: () => Promise.resolve(null),
		findByMediaFile: () => Promise.resolve(undefined),
	};
	const watchlistRepository: WatchlistRepo = {
		findWatchlistedIds: () => Promise.resolve(new Set(options.watchlistedIds ?? [])),
		remove: (profileId: string, metadataId: string) => {
			watchlistRemovals.push(`${profileId}:${metadataId}`);

			return Promise.resolve();
		},
	};

	const service = new PlaybackProgressService({
		watchlistRepository,
		playbackRepository,
		watchedHistoryRepository,
		profileStreamPrefsRepository,
		profilePreferencesRepository: {
			getEffective: () => Promise.resolve({ continueWatchingMinutes: 2, watchlistAutoRemoveWatched: options.autoRemoveWatched ?? false }),
		},
		publisher,
	});

	return { service, upserts, watchedSyncs, published, resets, continueWatchingData, prefsUpserts, watchlistRemovals };
}

describe("playback progress service", () => {
	test("normalizes position, persists progress and publishes the update", async () => {
		const { service, upserts, watchedSyncs, published } = createService();

		const result = await service.updatePlaybackProgress("file-1", { position: 1500 }, "profile-1");

		expect(result).toEqual({ success: true });
		expect(upserts[0]).toMatchObject({ profileId: "profile-1", fileId: "file-1", position: 1000, duration: 1000, completed: true });
		expect(watchedSyncs).toHaveLength(1);
		expect(published[0]).toMatchObject({ mediaFileId: "file-1", position: 1000, completed: true });
	});

	test("finishing a title clears the profile's discover/insight caches; plain progress does not", async () => {
		const cleared = stubMethod(discoverService, "clearCache", () => undefined);
		const { service } = createService();

		await service.updatePlaybackProgress("file-1", { position: 100 }, "profile-1");
		expect(cleared.calls).toHaveLength(0);

		await service.updatePlaybackProgress("file-1", { position: 1000 }, "profile-1");
		expect(cleared.calls).toEqual([["profile-1"]]);
		cleared.restore();
	});

	test("keeps the previous stream selection when the request omits it", async () => {
		const { service, upserts, watchedSyncs } = createService({
			existingProgress: { completed: false, audioStreamIndex: 2, subtitleId: "sub-1" },
		});

		await service.updatePlaybackProgress("file-1", { position: 100 }, "profile-1");

		expect(upserts[0]).toMatchObject({ position: 100, completed: false, audioStreamIndex: 2, subtitleId: "sub-1" });
		expect(watchedSyncs).toHaveLength(0);
	});

	test("does not re-sync watched history for an already completed file", async () => {
		const { service, watchedSyncs } = createService({ existingProgress: { completed: true } });

		await service.updatePlaybackProgress("file-1", { position: 1000 }, "profile-1");

		expect(watchedSyncs).toHaveLength(0);
	});

	test("reset deletes metadata-wide progress when the file belongs to metadata", async () => {
		const { service, resets } = createService();

		await service.resetPlaybackProgress("file-1", "profile-1");

		expect(resets.metadata).toEqual(["profile-1:meta-1"]);
		expect(resets.file).toEqual([]);
	});

	test("reset falls back to per-file deletion without linked metadata", async () => {
		const { service, resets } = createService({ fileMetadataId: null });

		await service.resetPlaybackProgress("file-1", "profile-1");

		expect(resets.file).toEqual(["profile-1:file-1"]);
		expect(resets.metadata).toEqual([]);
	});

	test("reset with scope file clears only that file", async () => {
		const { service, resets } = createService();

		await service.resetPlaybackProgress("file-1", "profile-1", "file");

		expect(resets.file).toEqual(["profile-1:file-1"]);
		expect(resets.metadata).toEqual([]);
	});

	test("bulk unwatch removes the progress of each distinct file", async () => {
		const { service, resets } = createService();

		const result = await service.setWatchStateBulk({ mediaFileIds: ["file-1", "file-2", "file-1"], watched: false }, "profile-1");

		expect(result).toEqual({ updated: 2 });
		expect(resets.bulk).toEqual(["profile-1:file-1", "profile-1:file-2"]);
	});

	test("bulk watch marks each file through the single update path", async () => {
		const { service } = createService();
		const update = stubMethod(service, "updatePlaybackProgress", () => Promise.resolve({ success: true }));

		await service.setWatchStateBulk({ mediaFileIds: ["file-1", "file-2"], watched: true }, "profile-1");

		expect(update.calls).toEqual([
			["file-1", { position: Number.MAX_SAFE_INTEGER }, "profile-1"],
			["file-2", { position: Number.MAX_SAFE_INTEGER }, "profile-1"],
		]);
	});

	test("bulk rejects the whole request when one file is unknown and writes nothing", async () => {
		const { service, resets } = createService({ unknownFileIds: ["file-2"] });

		await expect(service.setWatchStateBulk({ mediaFileIds: ["file-1", "file-2"], watched: false }, "profile-1")).rejects.toHaveProperty(
			"code",
			"entity.not_found",
		);
		expect(resets.bulk).toEqual([]);
	});

	test("finishing a title takes it off the watchlist when the profile asked for that", async () => {
		const { service, watchlistRemovals } = createService({ autoRemoveWatched: true });
		stubMethod(service, "getPlaybackProgress", () => Promise.resolve({ status: "watched" }));

		await service.updatePlaybackProgress("file-1", { position: 1000 }, "profile-1");

		expect(watchlistRemovals).toEqual(["profile-1:meta-1"]);
	});

	test("keeps the watchlist when the profile has not asked for removal", async () => {
		const { service, watchlistRemovals } = createService();
		stubMethod(service, "getPlaybackProgress", () => Promise.resolve({ status: "watched" }));

		await service.updatePlaybackProgress("file-1", { position: 1000 }, "profile-1");

		expect(watchlistRemovals).toEqual([]);
	});

	test("keeps a title that is not watched yet, even with removal on", async () => {
		const { service, watchlistRemovals } = createService({ autoRemoveWatched: true });
		stubMethod(service, "getPlaybackProgress", () => Promise.resolve({ status: "in_progress" }));

		await service.updatePlaybackProgress("file-1", { position: 1000 }, "profile-1");

		expect(watchlistRemovals).toEqual([]);
	});

	test("getContinueWatching feeds repository data into the builder", async () => {
		const { service, continueWatchingData } = createService({
			continueWatchingData: {
				progressRows: [
					{
						id: "p-1",
						profileId: "profile-1",
						mediaFileId: "file-1",
						metadataId: "meta-1",
						movieId: "movie-1",
						episodeId: null,
						position: 600,
						duration: 1200,
						completed: false,
						audioStreamIndex: null,
						subtitleId: null,
						updatedAt: new Date("2026-01-02T00:00:00Z"),
						dismissedAt: null,
					},
				],
				metadataList: [{ id: "meta-1", title: "Movie", type: "movie" }],
				mediaFiles: [],
				seasons: [],
				episodes: [],
				backdrops: [],
			},
		});

		const { items } = await service.getContinueWatching("profile-1", 12);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ mediaFileId: "file-1", metadata: { type: "movie" } });
		expect(continueWatchingData).toBeDefined();
	});

	test("dismissing a title hides it without resetting progress", async () => {
		const { service, resets } = createService();

		await service.dismissContinueWatching("meta-1", "profile-1");

		expect(resets.dismissed).toEqual(["profile-1:meta-1"]);
		expect(resets.metadata).toEqual([]);
		expect(resets.file).toEqual([]);
	});

	test("compute methods delegate to the aggregator", () => {
		const { service } = createService();

		const progress = service.computePlaybackProgress({
			metadata: { type: "movie" },
			mediaFiles: [{ id: "file-1", movieId: "movie-1", episodeId: null }],
			progressRows: [{ mediaFileId: "file-1", position: 600, duration: 1200, completed: false, updatedAt: new Date() }],
			episodes: [],
		});

		expect(progress.status).toBe("in_progress");
	});

	test("requires an authenticated profile", async () => {
		const { service } = createService();

		const error: unknown = await service.updatePlaybackProgress("file-1", { position: 10 }).catch((caught: unknown) => caught);

		expect(error).toMatchObject({ category: "unauthorized", code: "auth.profile_required" });
	});

	test("persists picked track languages per title/series", async () => {
		const { service, prefsUpserts } = createService();

		await service.updatePlaybackProgress("file-1", { position: 100, audioLanguage: "jpn", subtitleLanguage: "pol" }, "profile-1");
		await service.updatePlaybackProgress("file-1", { position: 200, subtitleLanguage: null }, "profile-1");

		expect(prefsUpserts[0]).toMatchObject({ profileId: "profile-1", metadataId: "meta-1", audioLanguage: "jpn", subtitleLanguage: "pol" });
		// Explicit null clears the stored language; untouched field stays undefined (= not overwritten).
		expect(prefsUpserts[1]?.audioLanguage).toBeUndefined();
	});

	test("does not touch stream prefs when no language is sent", async () => {
		const { service, prefsUpserts } = createService();

		await service.updatePlaybackProgress("file-1", { position: 100 }, "profile-1");

		expect(prefsUpserts).toHaveLength(0);
	});
});

test("batches smart play with watchlist flags and maps per-id repository data", async () => {
	const updatedAt = new Date("2026-01-02T00:00:00Z");
	const { service } = createService({
		watchlistedIds: ["meta-1"],
		smartPlayBatchData: [
			{
				metadataId: "meta-1",
				data: {
					metadata: { type: "movie", numberingMode: null },
					mediaFiles: [{ id: "file-1", metadataId: "meta-1", movieId: "movie-1", episodeId: null, isDefault: true, updatedAt }],
					progressRows: [],
					seasons: [],
					episodes: [],
				},
			},
			{ metadataId: "meta-2", data: null },
		],
	});

	const result = await service.getSmartPlayBatch(["meta-1", "meta-2", "  "], "profile-1");

	expect(result.suggestions).toHaveLength(2);
	expect(result.suggestions[0]).toEqual({ metadataId: "meta-1", suggestion: { type: "new", mediaFileId: "file-1" }, inWatchlist: true });
	expect(result.suggestions[1]).toEqual({ metadataId: "meta-2", suggestion: null, inWatchlist: false });
});

test("degrades the whole batch to null suggestions when the repository fails", async () => {
	const { service } = createService({ watchlistedIds: ["meta-1"], smartPlayBatchFails: true });

	const result = await service.getSmartPlayBatch(["meta-1", "meta-2"], "profile-1");

	expect(result.suggestions).toHaveLength(2);
	expect(result.suggestions[0]).toMatchObject({ metadataId: "meta-1", suggestion: null, inWatchlist: true });
	expect(result.suggestions[1]).toMatchObject({ metadataId: "meta-2", suggestion: null, inWatchlist: false });
});
