import { beforeEach, describe, expect, test } from "bun:test";
import { profilePreferencesRepository } from "@/repositories/profile-preferences.repository";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import {
	insertProfiles,
	insertUsers,
	insertWatchedHistory,
	insertWatchlist,
	selectPlaybackProgress,
	selectWatchedHistory,
	selectWatchlist,
	updateMediaFileDuration,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { watchedHistoryService } from "./watched-history.service";

// Media files, playback progress and watched history run against the migrated test database.
const db = useTestDatabase();

beforeEach(async () => {
	await insertUsers(db.client(), { id: "user-1", name: "Alice", email: "alice@example.test", emailVerified: true });
	await insertProfiles(db.client(), { id: "profile-1", userId: "user-1", name: "Main" });
	// The insight caches are module-scope and outlive each test's fresh database.
	watchedHistoryService.clearCache("profile-1");
});

/** A 600-second movie file, so a full watch stores a position and a duration of 600. */
async function seedMovieFile(): Promise<string> {
	const fileId = await insertMovieMediaFile(db.client(), "/media/Watched (2020)/watched.mkv", "meta-1");
	await updateMediaFileDuration(db.client(), fileId, 600);

	return fileId;
}

describe("WatchedHistoryService getInsights", () => {
	test("throws UnauthorizedError when profileId is missing", async () => {
		await expect(watchedHistoryService.getInsights("30d", undefined)).rejects.toMatchObject({
			category: "unauthorized",
			code: "auth.profile_required",
		});
	});

	test("counts a play inside the selected range", async () => {
		const fileId = await seedMovieFile();
		await insertWatchedHistory(db.client(), {
			id: "play-in-range",
			mediaFileId: fileId,
			profileId: "profile-1",
			durationWatched: 600,
			isFullWatch: false,
			watchedAt: new Date(Date.now() - 60_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const insights = await watchedHistoryService.getInsights("7d", "profile-1");

		expect(insights.totalMinutes).toBe(10);
	});

	test("reports zero minutes for days without activity", async () => {
		const insights = await watchedHistoryService.getInsights("7d", "profile-1");

		expect(insights.dailyActivity).toHaveLength(7);
		expect(insights.dailyActivity.every((day) => day.minutes === 0)).toBe(true);
	});
});

describe("WatchedHistoryService getWrapped", () => {
	test("lists at most five most-watched movies", async () => {
		const year = new Date().getFullYear();
		for (let index = 1; index <= 6; index++) {
			const fileId = await insertMovieMediaFile(db.client(), `/media/wrapped-${index}.mkv`, `wrapped-${index}`);
			await insertWatchedHistory(db.client(), {
				id: `wrapped-play-${index}`,
				mediaFileId: fileId,
				profileId: "profile-1",
				durationWatched: 600 + index,
				isFullWatch: true,
				watchedAt: new Date(year, 5, 15),
				createdAt: new Date(),
				updatedAt: new Date(),
			});
		}

		const wrapped = await watchedHistoryService.getWrapped(year, "profile-1");

		expect(wrapped.moviesWatchedCount).toBe(6);
		expect(wrapped.topMovies).toHaveLength(5);
	});
});

describe("WatchedHistoryService sync", () => {
	test("an unknown media file is a 404, not an FK violation", async () => {
		await expect(watchedHistoryService.sync({ mediaFileId: "file-missing" }, "profile-1")).rejects.toMatchObject({
			code: "entity.not_found",
			params: { entityType: "MediaFile", entityId: "file-missing" },
		});
	});

	test("marking a file watched advances Continue Watching", async () => {
		const fileId = await seedMovieFile();

		await watchedHistoryService.sync({ mediaFileId: fileId, isFullWatch: true }, "profile-1");

		const progress = (await selectPlaybackProgress(db.client())).filter((row) => row.mediaFileId === fileId);
		expect(progress).toMatchObject([{ profileId: "profile-1", position: 600, duration: 600, completed: true }]);
	});

	test("a partial watch records history but leaves playback progress untouched", async () => {
		const fileId = await seedMovieFile();

		await watchedHistoryService.sync({ mediaFileId: fileId }, "profile-1");

		expect(await selectPlaybackProgress(db.client())).toEqual([]);
		expect(await selectWatchedHistory(db.client())).toMatchObject([{ profileId: "profile-1", mediaFileId: fileId, isFullWatch: false }]);
	});

	test("marking an already finished file again adds no history row", async () => {
		const fileId = await seedMovieFile();

		await watchedHistoryService.sync({ mediaFileId: fileId, isFullWatch: true }, "profile-1");
		await watchedHistoryService.sync({ mediaFileId: fileId, isFullWatch: true }, "profile-1");

		expect(await selectWatchedHistory(db.client())).toHaveLength(1);
	});

	test("marking a title watched takes it off the watchlist when the profile asked for that", async () => {
		const fileId = await seedMovieFile();
		await profilePreferencesRepository.applyUpdate({ profileId: "profile-1", body: { watchlistAutoRemoveWatched: true } });
		await insertWatchlist(db.client(), { profileId: "profile-1", metadataId: "meta-1" });

		await watchedHistoryService.sync({ mediaFileId: fileId, isFullWatch: true }, "profile-1");

		expect(await selectWatchlist(db.client())).toEqual([]);
	});
});
