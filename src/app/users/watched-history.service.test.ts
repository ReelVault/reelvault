import { beforeEach, describe, expect, test } from "bun:test";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import {
	insertProfiles,
	insertUsers,
	selectPlaybackProgress,
	selectWatchedHistory,
	updateMediaFileDuration,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { watchedHistoryService } from "./watched-history.service";

// Media files, playback progress and watched history run against the migrated test database.
const db = useTestDatabase();

beforeEach(async () => {
	await insertUsers(db.client(), { id: "user-1", name: "Alice", email: "alice@example.test", emailVerified: true });
	await insertProfiles(db.client(), { id: "profile-1", userId: "user-1", name: "Main" });
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
});
