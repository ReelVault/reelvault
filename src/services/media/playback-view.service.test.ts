import { beforeEach, describe, expect, test } from "bun:test";
import { insertSeriesEpisode } from "../../../tests/helpers/media.fixture";
import {
	insertMediaFiles,
	insertPlaybackProgress,
	insertProfiles,
	insertUsers,
	selectMediaFiles,
	updateMediaFileDuration,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { playbackViewService } from "./playback-view.service";

const db = useTestDatabase();

beforeEach(async () => {
	await insertUsers(db.client(), { id: "user-1", name: "Ada", email: "ada@example.test", emailVerified: true });
	await insertProfiles(db.client(), { id: "profile-1", userId: "user-1", name: "Main" });
});

describe("playback view service", () => {
	test("returns the saved episode position in the playback view progress contract", async () => {
		const { episodeId } = await insertSeriesEpisode(db.client(), null);
		const mediaFile = (await selectMediaFiles(db.client())).find((row) => row.episodeId === episodeId);
		if (!mediaFile) throw new Error("Expected the seeded episode's media file");
		await updateMediaFileDuration(db.client(), mediaFile.id, 1200);
		await insertPlaybackProgress(db.client(), {
			profileId: "profile-1",
			mediaFileId: mediaFile.id,
			position: 600,
			duration: 1200,
			completed: false,
			audioStreamIndex: null,
			subtitleId: null,
			dismissedAt: null,
		});

		const view = await playbackViewService.getPlaybackView(mediaFile.id, "profile-1");

		expect(view.progress).toMatchObject({ mediaFileId: mediaFile.id, position: 600 });
	});
});

describe("playback view service: media-file versions", () => {
	test("resumes an episode from progress saved on another media-file version", async () => {
		const { episodeId } = await insertSeriesEpisode(db.client(), null);
		const firstFile = (await selectMediaFiles(db.client())).find((row) => row.episodeId === episodeId);
		if (!firstFile) throw new Error("Expected the seeded episode's media file");
		await updateMediaFileDuration(db.client(), firstFile.id, 1200);

		const [secondFile] = await insertMediaFiles(db.client(), {
			libraryId: firstFile.libraryId,
			metadataId: firstFile.metadataId,
			episodeId,
			filePath: "/tv/show/s01e01-alt.mkv",
			fileName: "s01e01-alt.mkv",
			duration: 1200,
		});
		if (!secondFile) throw new Error("Expected the inserted media file");
		await insertPlaybackProgress(db.client(), {
			profileId: "profile-1",
			mediaFileId: secondFile.id,
			position: 600,
			duration: 1200,
			completed: false,
			audioStreamIndex: null,
			subtitleId: null,
			dismissedAt: null,
		});

		const view = await playbackViewService.getPlaybackView(firstFile.id, "profile-1");

		expect(view.progress).toMatchObject({ mediaFileId: secondFile.id, position: 600 });
	});

	test("starts from zero when the saved progress belongs to a version with a different duration", async () => {
		const { episodeId } = await insertSeriesEpisode(db.client(), null);
		const firstFile = (await selectMediaFiles(db.client())).find((row) => row.episodeId === episodeId);
		if (!firstFile) throw new Error("Expected the seeded episode's media file");
		await updateMediaFileDuration(db.client(), firstFile.id, 1200);

		const [secondFile] = await insertMediaFiles(db.client(), {
			libraryId: firstFile.libraryId,
			metadataId: firstFile.metadataId,
			episodeId,
			filePath: "/tv/show/s01e01-long.mkv",
			fileName: "s01e01-long.mkv",
			duration: 1800,
		});
		if (!secondFile) throw new Error("Expected the inserted media file");
		await insertPlaybackProgress(db.client(), {
			profileId: "profile-1",
			mediaFileId: secondFile.id,
			position: 600,
			duration: 1800,
			completed: false,
			audioStreamIndex: null,
			subtitleId: null,
			dismissedAt: null,
		});

		const view = await playbackViewService.getPlaybackView(firstFile.id, "profile-1");

		expect(view.progress).toBeNull();
	});
});

describe("playback view service: latest compatible progress", () => {
	test("prefers the latest compatible episode progress across versions", async () => {
		const { episodeId } = await insertSeriesEpisode(db.client(), null);
		const firstFile = (await selectMediaFiles(db.client())).find((row) => row.episodeId === episodeId);
		if (!firstFile) throw new Error("Expected the seeded episode's media file");
		await updateMediaFileDuration(db.client(), firstFile.id, 1200);

		const [secondFile] = await insertMediaFiles(db.client(), {
			libraryId: firstFile.libraryId,
			metadataId: firstFile.metadataId,
			episodeId,
			filePath: "/tv/show/s01e01-alt.mkv",
			fileName: "s01e01-alt.mkv",
			duration: 1200,
		});
		if (!secondFile) throw new Error("Expected the inserted media file");

		await insertPlaybackProgress(db.client(), {
			profileId: "profile-1",
			mediaFileId: firstFile.id,
			position: 100,
			duration: 1200,
			completed: false,
			audioStreamIndex: null,
			subtitleId: null,
			dismissedAt: null,
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		});
		await insertPlaybackProgress(db.client(), {
			profileId: "profile-1",
			mediaFileId: secondFile.id,
			position: 900,
			duration: 1200,
			completed: false,
			audioStreamIndex: null,
			subtitleId: null,
			dismissedAt: null,
			updatedAt: new Date("2026-01-02T00:00:00Z"),
		});

		const view = await playbackViewService.getPlaybackView(firstFile.id, "profile-1");

		expect(view.progress).toMatchObject({ mediaFileId: secondFile.id, position: 900 });
	});

	test("falls back to the opened file when the latest progress belongs to a version with a different duration", async () => {
		const { episodeId } = await insertSeriesEpisode(db.client(), null);
		const firstFile = (await selectMediaFiles(db.client())).find((row) => row.episodeId === episodeId);
		if (!firstFile) throw new Error("Expected the seeded episode's media file");
		await updateMediaFileDuration(db.client(), firstFile.id, 1200);

		const [secondFile] = await insertMediaFiles(db.client(), {
			libraryId: firstFile.libraryId,
			metadataId: firstFile.metadataId,
			episodeId,
			filePath: "/tv/show/s01e01-long.mkv",
			fileName: "s01e01-long.mkv",
			duration: 1800,
		});
		if (!secondFile) throw new Error("Expected the inserted media file");

		await insertPlaybackProgress(db.client(), {
			profileId: "profile-1",
			mediaFileId: firstFile.id,
			position: 100,
			duration: 1200,
			completed: false,
			audioStreamIndex: null,
			subtitleId: null,
			dismissedAt: null,
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		});
		await insertPlaybackProgress(db.client(), {
			profileId: "profile-1",
			mediaFileId: secondFile.id,
			position: 600,
			duration: 1800,
			completed: false,
			audioStreamIndex: null,
			subtitleId: null,
			dismissedAt: null,
			updatedAt: new Date("2026-01-02T00:00:00Z"),
		});

		const view = await playbackViewService.getPlaybackView(firstFile.id, "profile-1");

		expect(view.progress).toMatchObject({ mediaFileId: firstFile.id, position: 100 });
	});
});
