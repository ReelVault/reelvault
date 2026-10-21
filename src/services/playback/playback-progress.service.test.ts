import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { playbackRepository } from "@/repositories/playback.repository";
import { profilePreferencesRepository } from "@/repositories/profile-preferences.repository";
import { profileStreamPrefsRepository } from "@/repositories/profile-stream-prefs.repository";
import { unitOfWorkRepository } from "@/repositories/unit-of-work.repository";
import { watchedHistoryRepository } from "@/repositories/watched-history.repository";
import { watchlistRepository } from "@/repositories/watchlist.repository";
import { discoverService } from "@/services/users/discover.service";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import {
	insertEpisodes,
	insertLibraries,
	insertMediaFiles,
	insertMetadata,
	insertPlaybackProgress,
	insertProfiles,
	insertSeasons,
	insertUsers,
	insertWatchlist,
	selectMediaFiles,
	selectPlaybackProgress,
	selectProfileStreamPrefs,
	selectWatchedHistory,
	selectWatchlist,
	updateMediaFileDuration,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import type { PlaybackProgressUpdateEvent } from "./playback-progress.publisher";
import { PlaybackProgressService } from "./playback-progress.service";

// Progress, history, stream prefs, watchlist and profile preferences go through the real
// repositories against the migrated test database. Stubbed: the realtime publisher (the
// emitted payload is the assertion), the discover cache clear (only observable through this
// call), and one smart-play read that fails, to simulate an outage.
const db = useTestDatabase();
const stubs: Array<{ restore(): void }> = [];
let published: PlaybackProgressUpdateEvent[] = [];

function createService(): PlaybackProgressService {
	return new PlaybackProgressService({
		playbackRepository,
		watchedHistoryRepository,
		profileStreamPrefsRepository,
		profilePreferencesRepository,
		watchlistRepository,
		publisher: {
			publishUpdate: (event) => {
				published.push(event);
			},
		},
		runTransaction: (work) => unitOfWorkRepository.run(work),
	});
}

async function seedProfile(): Promise<void> {
	await insertUsers(db.client(), { id: "user-1", name: "Alice", email: "alice@example.test", emailVerified: true });
	await insertProfiles(db.client(), { id: "profile-1", userId: "user-1", name: "Main" });
}

/** A 1000-second movie file; `metadataId` is the title's id and the title's name. */
async function seedMovie(metadataId = "meta-1"): Promise<string> {
	const fileId = await insertMovieMediaFile(db.client(), `/media/${metadataId}/${metadataId}.mkv`, metadataId);
	await updateMediaFileDuration(db.client(), fileId, 1000);

	return fileId;
}

/** A second file of the first file's title, sharing its library, metadata and movie rows. */
async function seedSecondFile(firstFileId: string): Promise<string> {
	const first = (await selectMediaFiles(db.client())).find((row) => row.id === firstFileId);
	if (!first) throw new Error("Expected the first media file");

	const [row] = await insertMediaFiles(db.client(), {
		libraryId: first.libraryId,
		metadataId: first.metadataId,
		movieId: first.movieId,
		filePath: "/media/meta-1/second.mkv",
		fileName: "second.mkv",
		duration: 1000,
	});
	if (!row) throw new Error("Expected the insert to return a media file");

	return row.id;
}

function firstId(rows: Array<{ id: string }>): string {
	const row = rows[0];
	if (!row) throw new Error("Expected the insert to return a row");

	return row.id;
}

/** A two-episode series titled "show-1"; returns the media file id of each episode, in order. */
async function seedSeries(): Promise<[string, string]> {
	const client = db.client();
	const libraryId = firstId(await insertLibraries(client, { name: "Shows", type: "tv_shows" }));
	const metadataId = firstId(
		await insertMetadata(client, { id: "show-1", stableKey: "show-1", title: "show-1", type: "tv_show", releaseDate: "2020-01-01" }),
	);
	const seasonId = firstId(await insertSeasons(client, { stableKey: "show-1-s1", metadataId, seasonNumber: 1 }));

	const fileIds: string[] = [];
	for (const episodeNumber of [1, 2]) {
		const episodeId = firstId(
			await insertEpisodes(client, { stableKey: `show-1-s1e${episodeNumber}`, seasonId, episodeNumber, title: `Episode ${episodeNumber}` }),
		);
		fileIds.push(
			firstId(
				await insertMediaFiles(client, {
					libraryId,
					metadataId,
					episodeId,
					filePath: `/tv/show-1/S01E0${episodeNumber}.mkv`,
					fileName: `S01E0${episodeNumber}.mkv`,
					duration: 1000,
				}),
			),
		);
	}

	return [fileIds[0] ?? "", fileIds[1] ?? ""];
}

async function seedProgress(
	fileId: string,
	values: { position: number; completed?: boolean; audioStreamIndex?: number; subtitleId?: string; dismissedAt?: Date },
): Promise<void> {
	await insertPlaybackProgress(db.client(), {
		profileId: "profile-1",
		mediaFileId: fileId,
		position: values.position,
		duration: 1000,
		completed: values.completed ?? false,
		audioStreamIndex: values.audioStreamIndex ?? null,
		subtitleId: values.subtitleId ?? null,
		dismissedAt: values.dismissedAt ?? null,
	});
}

async function seedWatchlist(metadataId: string): Promise<void> {
	await insertWatchlist(db.client(), { profileId: "profile-1", metadataId });
}

/** Goes through the repository so its per-profile overrides cache is invalidated, as it is in the app. */
async function setAutoRemoveWatched(enabled: boolean): Promise<void> {
	await profilePreferencesRepository.applyUpdate({ profileId: "profile-1", body: { watchlistAutoRemoveWatched: enabled } });
}

async function storedProgress() {
	return await selectPlaybackProgress(db.client());
}

async function storedWatchlist() {
	return await selectWatchlist(db.client());
}

beforeEach(async () => {
	published = [];
	await seedProfile();
	// The per-profile overrides cache outlives each test's database, so reset it with the rows.
	await profilePreferencesRepository.reset({ profileId: "profile-1" });
});

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("playback progress service: recording progress", () => {
	test("normalizes position, stores progress, records the play and publishes the update", async () => {
		const fileId = await seedMovie();

		await expect(createService().updatePlaybackProgress(fileId, { position: 1500 }, "profile-1")).resolves.toEqual({ success: true });

		expect(await storedProgress()).toEqual([
			expect.objectContaining({ mediaFileId: fileId, position: 1000, duration: 1000, completed: true }),
		]);
		expect(await selectWatchedHistory(db.client())).toHaveLength(1);
		expect(published[0]).toMatchObject({ mediaFileId: fileId, position: 1000, completed: true });
	});

	test("finishing a title clears the profile's discover/insight caches; plain progress does not", async () => {
		const cleared = stubMethod(discoverService, "clearCache", () => undefined);
		stubs.push(cleared);
		const fileId = await seedMovie();
		const service = createService();

		await service.updatePlaybackProgress(fileId, { position: 100 }, "profile-1");
		expect(cleared.calls).toHaveLength(0);

		await service.updatePlaybackProgress(fileId, { position: 1000 }, "profile-1");
		expect(cleared.calls).toEqual([["profile-1"]]);
	});

	test("keeps the previous stream selection when the request omits it", async () => {
		const fileId = await seedMovie();
		await seedProgress(fileId, { position: 0, audioStreamIndex: 2, subtitleId: "sub-1" });

		await createService().updatePlaybackProgress(fileId, { position: 100 }, "profile-1");

		expect(await storedProgress()).toEqual([
			expect.objectContaining({ position: 100, completed: false, audioStreamIndex: 2, subtitleId: "sub-1" }),
		]);
		expect(await selectWatchedHistory(db.client())).toHaveLength(0);
	});

	test("does not record the play again for a file that is already completed", async () => {
		const fileId = await seedMovie();
		await seedProgress(fileId, { position: 1000, completed: true });

		await createService().updatePlaybackProgress(fileId, { position: 1000 }, "profile-1");

		expect(await selectWatchedHistory(db.client())).toHaveLength(0);
	});
});

describe("playback progress service: resets and bulk changes", () => {
	test("reset clears the progress of every file of the title", async () => {
		const fileA = await seedMovie();
		const fileB = await seedSecondFile(fileA);
		await seedProgress(fileA, { position: 100 });
		await seedProgress(fileB, { position: 200 });

		await createService().resetPlaybackProgress(fileA, "profile-1");

		expect(await storedProgress()).toEqual([]);
	});

	test("reset with scope file clears only that file", async () => {
		const fileA = await seedMovie();
		const fileB = await seedSecondFile(fileA);
		await seedProgress(fileA, { position: 100 });
		await seedProgress(fileB, { position: 200 });

		await createService().resetPlaybackProgress(fileA, "profile-1", "file");

		expect((await storedProgress()).map((row) => row.mediaFileId)).toEqual([fileB]);
	});

	test("bulk unwatch removes the progress of each distinct file", async () => {
		const fileA = await seedMovie();
		const fileB = await seedSecondFile(fileA);
		await seedProgress(fileA, { position: 100 });
		await seedProgress(fileB, { position: 200 });

		const result = await createService().setWatchStateBulk({ mediaFileIds: [fileA, fileB, fileA], watched: false }, "profile-1");

		expect(result).toEqual({ updated: 2 });
		expect(await storedProgress()).toEqual([]);
	});

	test("bulk watch marks each file watched at its full duration", async () => {
		const fileA = await seedMovie();
		const fileB = await seedSecondFile(fileA);

		await createService().setWatchStateBulk({ mediaFileIds: [fileA, fileB], watched: true }, "profile-1");

		const rows = await storedProgress();
		expect(rows).toHaveLength(2);
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ mediaFileId: fileA, position: 1000, completed: true }),
				expect.objectContaining({ mediaFileId: fileB, position: 1000, completed: true }),
			]),
		);
	});

	test("bulk watch keeps the saved track choices and records one play per newly finished file", async () => {
		const cleared = stubMethod(discoverService, "clearCache", () => undefined);
		stubs.push(cleared);
		const fileA = await seedMovie();
		const fileB = await seedSecondFile(fileA);
		await seedProgress(fileA, { position: 100, audioStreamIndex: 2, subtitleId: "sub-pl" });

		await createService().setWatchStateBulk({ mediaFileIds: [fileA, fileB], watched: true }, "profile-1");

		expect(cleared.calls).toEqual([["profile-1"]]);

		const progress = await storedProgress();
		expect(progress.find((row) => row.mediaFileId === fileA)).toMatchObject({
			position: 1000,
			completed: true,
			audioStreamIndex: 2,
			subtitleId: "sub-pl",
		});
		const history = await selectWatchedHistory(db.client());
		expect(history.map((row) => row.mediaFileId).toSorted()).toEqual([fileA, fileB].toSorted());
		expect(history.every((row) => row.isFullWatch && row.durationWatched === 1000)).toBe(true);
		expect(published.map((event) => event.mediaFileId).toSorted()).toEqual([fileA, fileB].toSorted());

		// A second bulk of already-watched files must not add another play per file.
		await createService().setWatchStateBulk({ mediaFileIds: [fileA, fileB], watched: true }, "profile-1");

		expect(await selectWatchedHistory(db.client())).toHaveLength(2);
	});

	test("bulk rejects the whole request when one file is unknown and writes nothing", async () => {
		const fileA = await seedMovie();
		await seedProgress(fileA, { position: 100 });

		await expect(
			createService().setWatchStateBulk({ mediaFileIds: [fileA, "missing-file"], watched: false }, "profile-1"),
		).rejects.toHaveProperty("code", "entity.not_found");

		expect(await storedProgress()).toEqual([expect.objectContaining({ mediaFileId: fileA, position: 100 })]);
	});
});

describe("playback progress service: watchlist", () => {
	test("finishing a title takes it off the watchlist when the profile asked for that", async () => {
		const fileId = await seedMovie();
		await seedWatchlist("meta-1");
		await setAutoRemoveWatched(true);

		await createService().updatePlaybackProgress(fileId, { position: 1000 }, "profile-1");

		expect(await storedWatchlist()).toEqual([]);
	});

	test("keeps the watchlist when the profile has not asked for removal", async () => {
		const fileId = await seedMovie();
		await seedWatchlist("meta-1");

		await createService().updatePlaybackProgress(fileId, { position: 1000 }, "profile-1");

		expect(await storedWatchlist()).toHaveLength(1);
	});

	test("keeps a series while one of its episodes is still unwatched, even with removal on", async () => {
		const [episodeOne] = await seedSeries();
		await seedWatchlist("show-1");
		await setAutoRemoveWatched(true);

		await createService().updatePlaybackProgress(episodeOne, { position: 1000 }, "profile-1");

		expect(await storedWatchlist()).toHaveLength(1);
	});

	test("removes a series from the watchlist once every episode is watched", async () => {
		const [episodeOne, episodeTwo] = await seedSeries();
		await seedWatchlist("show-1");
		await setAutoRemoveWatched(true);
		const service = createService();

		await service.updatePlaybackProgress(episodeOne, { position: 1000 }, "profile-1");
		await service.updatePlaybackProgress(episodeTwo, { position: 1000 }, "profile-1");

		expect(await storedWatchlist()).toEqual([]);
	});
});

describe("playback progress service: reads and language preferences", () => {
	test("getContinueWatching lists the title's stored progress", async () => {
		const fileId = await seedMovie();
		await seedProgress(fileId, { position: 600 });

		const { data: items } = await createService().getContinueWatching("profile-1", 12);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ mediaFileId: fileId, metadata: { type: "movie" } });
	});

	test("dismissing a title hides it without resetting progress", async () => {
		const fileId = await seedMovie();
		await seedProgress(fileId, { position: 600 });

		await createService().dismissContinueWatching("meta-1", "profile-1");

		expect(await storedProgress()).toEqual([
			expect.objectContaining({ mediaFileId: fileId, position: 600, dismissedAt: expect.any(Date) }),
		]);
	});

	test("compute methods delegate to the aggregator", () => {
		const progress = createService().computePlaybackProgress({
			metadata: { type: "movie" },
			mediaFiles: [{ id: "file-1", movieId: "movie-1", episodeId: null }],
			progressRows: [{ mediaFileId: "file-1", position: 600, duration: 1200, completed: false, updatedAt: new Date() }],
			episodes: [],
		});

		expect(progress.status).toBe("in_progress");
	});

	test("requires an authenticated profile", async () => {
		const failure: unknown = await createService()
			.updatePlaybackProgress("file-1", { position: 10 })
			.catch((error: unknown) => error);

		expect(failure).toMatchObject({ category: "unauthorized", code: "auth.profile_required" });
	});

	test("persists picked track languages per title and keeps the audio language when only subtitles change", async () => {
		const fileId = await seedMovie();
		const service = createService();

		await service.updatePlaybackProgress(fileId, { position: 100, audioLanguage: "jpn", subtitleLanguage: "pol" }, "profile-1");
		expect(await selectProfileStreamPrefs(db.client())).toEqual([
			expect.objectContaining({ profileId: "profile-1", metadataId: "meta-1", audioLanguage: "jpn", subtitleLanguage: "pol" }),
		]);

		await service.updatePlaybackProgress(fileId, { position: 200, subtitleLanguage: null }, "profile-1");
		expect(await selectProfileStreamPrefs(db.client())).toEqual([
			expect.objectContaining({ audioLanguage: "jpn", subtitleLanguage: null }),
		]);
	});

	test("does not touch stream prefs when no language is sent", async () => {
		const fileId = await seedMovie();

		await createService().updatePlaybackProgress(fileId, { position: 100 }, "profile-1");

		expect(await selectProfileStreamPrefs(db.client())).toHaveLength(0);
	});
});

describe("playback progress service: smart play batch", () => {
	test("batches smart play with watchlist flags and maps per-id repository data", async () => {
		const fileId = await seedMovie();
		await seedWatchlist("meta-1");

		const result = await createService().getSmartPlayBatch(["meta-1", "meta-2", "  "], "profile-1");

		expect(result.suggestions).toHaveLength(2);
		expect(result.suggestions[0]).toEqual({ metadataId: "meta-1", suggestion: { type: "new", mediaFileId: fileId }, inWatchlist: true });
		expect(result.suggestions[1]).toEqual({ metadataId: "meta-2", suggestion: null, inWatchlist: false });
	});

	test("reads watchlist flags from the batch statement instead of a separate watchlist query", async () => {
		const fileId = await seedMovie();
		await seedWatchlist("meta-1");
		stubs.push(stubMethod(watchlistRepository, "findWatchlistedIds", () => Promise.reject(new Error("watchlist read must not run"))));

		const result = await createService().getSmartPlayBatch(["meta-1", "meta-2"], "profile-1");

		expect(result.suggestions[0]).toEqual({ metadataId: "meta-1", suggestion: { type: "new", mediaFileId: fileId }, inWatchlist: true });
		expect(result.suggestions[1]).toEqual({ metadataId: "meta-2", suggestion: null, inWatchlist: false });
	});

	test("degrades the whole batch to null suggestions when the repository fails", async () => {
		await seedMovie();
		await seedWatchlist("meta-1");
		stubs.push(stubMethod(playbackRepository, "findSmartPlayBatchData", () => Promise.reject(new Error("batch repository failure"))));

		const result = await createService().getSmartPlayBatch(["meta-1", "meta-2"], "profile-1");

		expect(result.suggestions).toHaveLength(2);
		expect(result.suggestions[0]).toMatchObject({ metadataId: "meta-1", suggestion: null, inWatchlist: true });
		expect(result.suggestions[1]).toMatchObject({ metadataId: "meta-2", suggestion: null, inWatchlist: false });
	});
});
