import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { MediaFileWithRelation } from "@reelvault/sdk/common";
import { spawn } from "bun";
import { systemSettingsStore } from "@/config/system-settings.store";
import { type DownloadRow, downloadsRepository } from "@/database/repositories/downloads.repository";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { FFmpegBuilder } from "@/integrations/ffmpeg/ffmpeg.builder";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { serverConfig } from "@/server.config";
import { DomainError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { createMockWorkerItem } from "@/workers/core/worker-runtime.test-utils";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { downloadsService } from "./downloads.service";

function row(overrides: Partial<DownloadRow> = {}): DownloadRow {
	return {
		id: "dl-1",
		profileId: "profile-1",
		mediaFileId: "file-1",
		quality: "720p-mobile",
		status: "pending",
		progressPercent: 0,
		sizeBytes: null,
		fileName: null,
		errorText: null,
		createdAt: new Date("2026-08-01T00:00:00.000Z"),
		updatedAt: new Date("2026-08-01T00:00:00.000Z"),
		...overrides,
	};
}

function createMockMediaFile(overrides: Partial<MediaFileWithRelation> = {}): MediaFileWithRelation {
	return {
		id: "file-1",
		libraryId: "lib-1",
		metadataId: "meta-1",
		movieId: "movie-1",
		episodeId: null,
		filePath: "/media/movie.mkv",
		fileName: "My.Movie.mkv",
		formatName: "matroska",
		duration: 3_600,
		size: 1_000_000,
		sourceMtimeMs: 123456,
		bitRate: 5000,
		source: null,
		edition: null,
		qualityTag: null,
		isDefault: true,
		isEnabled: true,
		createdAt: new Date("2026-08-01T00:00:00.000Z"),
		updatedAt: new Date("2026-08-01T00:00:00.000Z"),
		videoStreams: [],
		audioStreams: [],
		subtitles: [],
		library: {
			id: "lib-1",
			name: "Movies",
			type: "movies",
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
			updatedAt: new Date("2026-08-01T00:00:00.000Z"),
		},
		...overrides,
	};
}

const mediaFile = createMockMediaFile();

const findByPrimaryId = spyOn(mediaRepository, "findByPrimaryId").mockResolvedValue(mediaFile);
const insert = spyOn(downloadsRepository, "insert").mockResolvedValue(row());
const findById = spyOn(downloadsRepository, "findById").mockResolvedValue(undefined);
const update = spyOn(downloadsRepository, "update").mockResolvedValue(undefined);
const deleteRow = spyOn(downloadsRepository, "delete").mockResolvedValue(undefined);
const countProcessing = spyOn(downloadsRepository, "countProcessingByProfile").mockResolvedValue(0);
const countPending = spyOn(downloadsRepository, "countPendingByProfile").mockResolvedValue(0);
const hasActive = spyOn(downloadsRepository, "hasActiveByProfileAndMedia").mockResolvedValue(false);
const findPending = spyOn(downloadsRepository, "findPendingByProfile").mockResolvedValue([row()]);
const claim = spyOn(downloadsRepository, "claimForProcessing").mockResolvedValue(true);
const storageUsed = spyOn(downloadsRepository, "storageUsedByProfile").mockResolvedValue(0);
const findExpired = spyOn(downloadsRepository, "findExpired").mockResolvedValue([]);
const findByProfile = spyOn(downloadsRepository, "findByProfile").mockResolvedValue([]);
const findByStatuses = spyOn(downloadsRepository, "findByStatuses").mockResolvedValue([]);
const findIdentities = spyOn(mediaRepository, "findIdentitiesByIds").mockResolvedValue([]);
const addItem = spyOn(workerService, "addItem").mockResolvedValue(createMockWorkerItem({ id: "job-1" }));

beforeEach(() => {
	findByPrimaryId.mockClear().mockResolvedValue(mediaFile);
	insert.mockClear().mockResolvedValue(row());
	findById.mockClear().mockResolvedValue(undefined);
	update.mockClear();
	deleteRow.mockClear();
	countProcessing.mockClear().mockResolvedValue(0);
	countPending.mockClear().mockResolvedValue(0);
	hasActive.mockClear().mockResolvedValue(false);
	findPending.mockClear().mockResolvedValue([row()]);
	claim.mockClear().mockResolvedValue(true);
	storageUsed.mockClear().mockResolvedValue(0);
	findExpired.mockClear().mockResolvedValue([]);
	findByProfile.mockClear().mockResolvedValue([]);
	findByStatuses.mockClear().mockResolvedValue([]);
	findIdentities.mockClear().mockResolvedValue([]);
	addItem.mockClear().mockResolvedValue(createMockWorkerItem({ id: "job-1" }));
	systemSettingsStore.clearRuntimeValues();
});

const createdArtifacts: string[] = [];

afterEach(() => {
	for (const path of createdArtifacts.splice(0)) rmSync(path, { force: true });
});

describe("DownloadsService.prepare", () => {
	test("rejects disabled servers, unknown files and duration-less transcoding", async () => {
		systemSettingsStore.setRuntimeValue("downloads.enabled", false);
		await expect(downloadsService.prepare("profile-1", "file-1")).rejects.toMatchObject({
			code: "downloads.disabled",
			category: "forbidden",
		});
		systemSettingsStore.clearRuntimeValues();

		await expect(downloadsService.prepare(undefined, "file-1")).rejects.toThrow("Active profile required");
		await expect(downloadsService.prepare("profile-1", "  ")).rejects.toThrow("mediaFileId is required");
		findByPrimaryId.mockResolvedValueOnce(undefined);
		await expect(downloadsService.prepare("profile-1", "file-missing")).rejects.toThrow("file-missing");
		findByPrimaryId.mockResolvedValue(createMockMediaFile({ duration: 0 }));
		await expect(downloadsService.prepare("profile-1", "file-1", "1080p-desktop")).rejects.toThrow("known file duration");

		// "original" skips the duration gate.
		await downloadsService.prepare("profile-1", "file-1", "original");
		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ quality: "original" }));
	});

	test("queues a download beyond the running slots without starting it", async () => {
		countProcessing.mockResolvedValue(1);
		await downloadsService.prepare("profile-1", "file-1");

		expect(insert).toHaveBeenCalled();
		expect(addItem).not.toHaveBeenCalled();
		countProcessing.mockResolvedValue(0);
	});

	test("refuses a second copy of a download the profile already has waiting or running", async () => {
		hasActive.mockResolvedValue(true);
		await expect(downloadsService.prepare("profile-1", "file-1")).rejects.toMatchObject({
			code: "downloads.in_progress",
			category: "conflict",
		});
		expect(insert).not.toHaveBeenCalled();
	});

	test("refuses a download once the profile has too many waiting", async () => {
		countPending.mockResolvedValue(200);
		await expect(downloadsService.prepare("profile-1", "file-1")).rejects.toMatchObject({
			code: "downloads.queue_full",
			category: "conflict",
		});
		countPending.mockResolvedValue(0);
	});

	test("enforces the storage quota", async () => {
		storageUsed.mockResolvedValue(100);
		systemSettingsStore.setRuntimeValue("downloads.maxStorageBytesPerProfile", 100);
		await expect(downloadsService.prepare("profile-1", "file-1")).rejects.toMatchObject({
			code: "downloads.quota_exceeded",
			category: "conflict",
		});
		systemSettingsStore.clearRuntimeValues();
	});

	test("falls back to 720p-mobile for an unknown quality string and enqueues the worker", async () => {
		await downloadsService.prepare("profile-1", "file-1", "8k-ultra");

		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ profileId: "profile-1", quality: "720p-mobile" }));
		expect(addItem).toHaveBeenCalledWith("downloads-process", { downloadId: "dl-1" }, expect.objectContaining({ dedupeKey: "dl-1" }));
	});
});

describe("DownloadsService ownership-checked views", () => {
	test("getJobViewForProfile hides other profiles' jobs", async () => {
		findById.mockResolvedValue(row());
		expect((await downloadsService.getJobViewForProfile("dl-1", "profile-1"))?.downloadUrl).toBe(null);
		expect(await downloadsService.getJobViewForProfile("dl-1", "profile-2")).toBe(null);

		findById.mockResolvedValue(row({ status: "completed", sizeBytes: 5, fileName: "movie.mp4" }));
		expect((await downloadsService.getJobViewForProfile("dl-1", "profile-1"))?.downloadUrl).toBe("/v1/downloads/dl-1/file");
	});

	test("cancel/delete for a foreign profile throw download_not_found", async () => {
		findById.mockResolvedValue(row());
		await expect(downloadsService.cancelForProfile("dl-1", "profile-2")).rejects.toThrow("Download not found");
		await expect(downloadsService.deleteForProfile("dl-1", "profile-2")).rejects.toThrow("Download not found");
		expect(deleteRow).not.toHaveBeenCalled();
	});

	test("completed downloads cannot be cancelled", async () => {
		findById.mockResolvedValue(row({ status: "completed" }));
		await expect(downloadsService.cancelForProfile("dl-1", "profile-1")).rejects.toThrow("Completed download cannot be cancelled");
	});
});

describe("DownloadsService job views", () => {
	test("list and single views carry the title of the media file", async () => {
		findByProfile.mockResolvedValue([row({ id: "dl-1", mediaFileId: "file-1" })]);
		findIdentities.mockResolvedValue([{ id: "file-1", metadataId: "meta-7" }]);

		const listed = await downloadsService.list("profile-1");
		expect(listed.data[0]).toMatchObject({ id: "dl-1", metadataId: "meta-7" });

		findById.mockResolvedValue(row({ id: "dl-1", mediaFileId: "file-1" }));
		expect(await downloadsService.getJobViewForProfile("dl-1", "profile-1")).toMatchObject({ metadataId: "meta-7" });
	});

	test("a media file without a title gives a null title id", async () => {
		findByProfile.mockResolvedValue([row({ id: "dl-1", mediaFileId: "file-1" })]);

		const listed = await downloadsService.list("profile-1");

		expect(listed.data[0]?.metadataId).toBeNull();
	});
});

describe("DownloadsService.process", () => {
	function fakeFfmpeg(exitCode: number | null, onSpawn?: (outputPath: string) => void) {
		let exitHandler: Parameters<FFmpegBuilder["onExit"]>[0] | undefined;
		let outputPath = "";
		const fakeProc = spawn({ cmd: ["true"], stdout: "ignore", stderr: "pipe" });

		class FakeBuilder extends FFmpegBuilder {
			override input() {
				return this;
			}
			override outputArgs() {
				return this;
			}
			override onProgress() {
				return this;
			}
			override onExit(handler: NonNullable<Parameters<FFmpegBuilder["onExit"]>[0]>) {
				exitHandler = handler;

				return this;
			}
			override run(path: string) {
				outputPath = path;
				onSpawn?.(path);
				queueMicrotask(() => exitHandler?.(fakeProc, exitCode, null));

				return fakeProc;
			}
		}
		const spy = spyOn(ffMpegService, "create").mockReturnValue(new FakeBuilder());

		return {
			spy,
			get outputPath() {
				return outputPath;
			},
		};
	}

	test("runs pending → processing → completed and records the artifact size", async () => {
		findById.mockResolvedValueOnce(row()).mockResolvedValueOnce(row());
		const statuses: string[] = [];
		claim.mockImplementationOnce(() => {
			statuses.push("processing");

			return Promise.resolve(true);
		});
		update.mockImplementation((_id: string, values: { status?: string }) => {
			if (values.status) statuses.push(values.status);

			return Promise.resolve();
		});

		const fake = fakeFfmpeg(0, (outputPath) => {
			mkdirSync(serverConfig.paths.downloads, { recursive: true });
			writeFileSync(outputPath, "video-bytes");
			createdArtifacts.push(outputPath);
		});

		await downloadsService.process("dl-1");

		expect(claim).toHaveBeenCalledWith("dl-1", "profile-1", 1);
		expect(statuses).toEqual(["processing", "completed"]);
		expect(update).toHaveBeenCalledWith("dl-1", expect.objectContaining({ status: "completed", progressPercent: 100, sizeBytes: 11 }));
		expect(fake.outputPath).toContain("dl-1");
		expect(fake.outputPath.endsWith("My.Movie.720p-mobile.mp4")).toBe(true);
		fake.spy.mockRestore();
	});

	test("sanitizes the output file name", async () => {
		findById.mockResolvedValue(row()).mockResolvedValueOnce(row());
		findByPrimaryId.mockResolvedValue(createMockMediaFile({ fileName: 'Bad:Name?*"<>.mkv' }));
		const fake = fakeFfmpeg(0, (outputPath) => {
			mkdirSync(serverConfig.paths.downloads, { recursive: true });
			writeFileSync(outputPath, "x");
			createdArtifacts.push(outputPath);
		});

		await downloadsService.process("dl-1");
		expect(fake.outputPath.endsWith("Bad_Name_.720p-mobile.mp4")).toBe(true);
		fake.spy.mockRestore();
	});
});

describe("DownloadsService.process", () => {
	function fakeFfmpeg(exitCode: number | null, onSpawn?: (outputPath: string) => void) {
		let exitHandler: Parameters<FFmpegBuilder["onExit"]>[0] | undefined;
		let outputPath = "";
		const fakeProc = spawn({ cmd: ["true"], stdout: "ignore", stderr: "pipe" });

		class FakeBuilder extends FFmpegBuilder {
			override input() {
				return this;
			}
			override outputArgs() {
				return this;
			}
			override onProgress() {
				return this;
			}
			override onExit(handler: NonNullable<Parameters<FFmpegBuilder["onExit"]>[0]>) {
				exitHandler = handler;

				return this;
			}
			override run(path: string) {
				outputPath = path;
				onSpawn?.(path);
				queueMicrotask(() => exitHandler?.(fakeProc, exitCode, null));

				return fakeProc;
			}
		}
		const spy = spyOn(ffMpegService, "create").mockReturnValue(new FakeBuilder());

		return {
			spy,
			get outputPath() {
				return outputPath;
			},
		};
	}

	test("a non-zero exit fails the job and removes the partial file", async () => {
		findById.mockResolvedValue(row()).mockResolvedValueOnce(row());
		const fake = fakeFfmpeg(1, (outputPath) => {
			mkdirSync(serverConfig.paths.downloads, { recursive: true });
			writeFileSync(outputPath, "partial");
			createdArtifacts.push(outputPath);
		});

		await downloadsService.process("dl-1");

		expect(update).toHaveBeenCalledWith("dl-1", expect.objectContaining({ status: "failed" }));
		expect(await FileUtils.exists(fake.outputPath)).toBe(false);
		fake.spy.mockRestore();
	});

	test("an empty artifact fails the job", async () => {
		findById.mockResolvedValue(row()).mockResolvedValueOnce(row());
		const fake = fakeFfmpeg(0, (outputPath) => {
			mkdirSync(serverConfig.paths.downloads, { recursive: true });
			writeFileSync(outputPath, "");
			createdArtifacts.push(outputPath);
		});

		await downloadsService.process("dl-1");

		expect(update).toHaveBeenCalledWith("dl-1", expect.objectContaining({ status: "failed", errorText: "download.empty_output" }));
		fake.spy.mockRestore();
	});

	test("a cancelled row written mid-run makes the exit handler drop the file", async () => {
		findById.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: "cancelled" }));
		const fake = fakeFfmpeg(0, (outputPath) => {
			mkdirSync(serverConfig.paths.downloads, { recursive: true });
			writeFileSync(outputPath, "partial");
			createdArtifacts.push(outputPath);
		});

		await downloadsService.process("dl-1");

		// No completed/failed update after the cancellation was observed.
		expect(update).toHaveBeenCalledWith("dl-1", expect.objectContaining({ fileName: "My.Movie.720p-mobile.mp4" }));
		expect(update).not.toHaveBeenCalledWith("dl-1", expect.objectContaining({ status: "completed" }));
		expect(await FileUtils.exists(fake.outputPath)).toBe(false);
		fake.spy.mockRestore();
	});
});

describe("DownloadsService.process", () => {
	function fakeFfmpeg(exitCode: number | null, onSpawn?: (outputPath: string) => void) {
		let exitHandler: Parameters<FFmpegBuilder["onExit"]>[0] | undefined;
		let outputPath = "";
		const fakeProc = spawn({ cmd: ["true"], stdout: "ignore", stderr: "pipe" });

		class FakeBuilder extends FFmpegBuilder {
			override input() {
				return this;
			}
			override outputArgs() {
				return this;
			}
			override onProgress() {
				return this;
			}
			override onExit(handler: NonNullable<Parameters<FFmpegBuilder["onExit"]>[0]>) {
				exitHandler = handler;

				return this;
			}
			override run(path: string) {
				outputPath = path;
				onSpawn?.(path);
				queueMicrotask(() => exitHandler?.(fakeProc, exitCode, null));

				return fakeProc;
			}
		}
		const spy = spyOn(ffMpegService, "create").mockReturnValue(new FakeBuilder());

		return {
			spy,
			get outputPath() {
				return outputPath;
			},
		};
	}

	test("the completion-time storage quota rejects oversized artifacts", async () => {
		findById.mockResolvedValue(row()).mockResolvedValueOnce(row());
		storageUsed.mockResolvedValue(95);
		systemSettingsStore.setRuntimeValue("downloads.maxStorageBytesPerProfile", 100);
		const fake = fakeFfmpeg(0, (outputPath) => {
			mkdirSync(serverConfig.paths.downloads, { recursive: true });
			writeFileSync(outputPath, "0123456789");
			createdArtifacts.push(outputPath);
		});

		await downloadsService.process("dl-1");

		expect(update).toHaveBeenCalledWith("dl-1", expect.objectContaining({ status: "failed" }));
		expect(await FileUtils.exists(fake.outputPath)).toBe(false);
		systemSettingsStore.clearRuntimeValues();
		fake.spy.mockRestore();
	});

	test("a non-pending row is a no-op", async () => {
		findById.mockResolvedValue(row({ status: "completed" }));
		await downloadsService.process("dl-1");
		expect(update).not.toHaveBeenCalled();
	});

	test("a download waiting for a running slot stays pending", async () => {
		findById.mockResolvedValue(row());
		claim.mockResolvedValueOnce(false);
		const fake = fakeFfmpeg(0);

		await downloadsService.process("dl-1");

		expect(fake.spy).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		fake.spy.mockRestore();
	});

	test("missing media file fails the job instead of leaving it pending", async () => {
		findById.mockResolvedValue(row());
		findByPrimaryId.mockResolvedValue(undefined);

		await downloadsService.process("dl-1");

		expect(update).toHaveBeenCalledWith("dl-1", expect.objectContaining({ status: "failed", errorText: "download.media_missing" }));
	});
});

describe("DownloadsService.queueSeason", () => {
	test("refuses a season larger than the free storage until it is forced, then queues each episode", async () => {
		const restoreSeason = stubMethod(seasonsRepository, "findByPrimaryId", () => Promise.resolve({ id: "season-1", metadataId: "show-1" }));
		const restoreEpisodes = stubMethod(episodesRepository, "findEpisodesWithFilesByMetadataId", () =>
			Promise.resolve([
				{ id: "ep-1", seasonId: "season-1", mediaFileId: "file-1", mediaFileIsDefault: true, mediaFileSize: 600 },
				{ id: "ep-2", seasonId: "season-1", mediaFileId: null, mediaFileIsDefault: null, mediaFileSize: null },
				{ id: "ep-3", seasonId: "season-2", mediaFileId: "file-9", mediaFileIsDefault: true, mediaFileSize: 900 },
			]),
		);
		systemSettingsStore.setRuntimeValue("downloads.maxStorageBytesPerProfile", 500);
		const assertAccess = () => Promise.resolve();
		try {
			await expect(downloadsService.queueSeason("profile-1", { seasonId: "season-1" }, assertAccess)).rejects.toMatchObject({
				code: "downloads.season_exceeds_quota",
				params: { estimatedBytes: 600, freeBytes: 500 },
			});

			const outcome = await downloadsService.queueSeason("profile-1", { seasonId: "season-1", force: true }, assertAccess);

			expect(outcome).toEqual({
				results: [
					{ id: "ep-1", ok: true },
					{ id: "ep-2", ok: false, code: "downloads.no_media_file" },
				],
			});
			expect(insert).toHaveBeenCalledWith(expect.objectContaining({ mediaFileId: "file-1" }));
		} finally {
			systemSettingsStore.clearRuntimeValues();
			restoreSeason.restore();
			restoreEpisodes.restore();
		}
	});

	test("reports an episode that is already downloading by its code and queues the rest of the season", async () => {
		const restoreSeason = stubMethod(seasonsRepository, "findByPrimaryId", () => Promise.resolve({ id: "season-1", metadataId: "show-1" }));
		const restoreEpisodes = stubMethod(episodesRepository, "findEpisodesWithFilesByMetadataId", () =>
			Promise.resolve([
				{ id: "ep-1", seasonId: "season-1", mediaFileId: "file-1", mediaFileIsDefault: true, mediaFileSize: 10 },
				{ id: "ep-2", seasonId: "season-1", mediaFileId: "file-2", mediaFileIsDefault: true, mediaFileSize: 10 },
			]),
		);
		hasActive.mockImplementation((_profileId: string, mediaFileId: string) => Promise.resolve(mediaFileId === "file-2"));
		try {
			expect(await downloadsService.queueSeason("profile-1", { seasonId: "season-1" }, () => Promise.resolve())).toEqual({
				results: [
					{ id: "ep-1", ok: true },
					{ id: "ep-2", ok: false, code: "downloads.in_progress" },
				],
			});
		} finally {
			hasActive.mockResolvedValue(false);
			restoreSeason.restore();
			restoreEpisodes.restore();
		}
	});

	test("reports an episode whose media file the caller may not stream by its code", async () => {
		const restoreSeason = stubMethod(seasonsRepository, "findByPrimaryId", () => Promise.resolve({ id: "season-1", metadataId: "show-1" }));
		const restoreEpisodes = stubMethod(episodesRepository, "findEpisodesWithFilesByMetadataId", () =>
			Promise.resolve([{ id: "ep-1", seasonId: "season-1", mediaFileId: "file-1", mediaFileIsDefault: true, mediaFileSize: 10 }]),
		);
		const assertAccess = () => Promise.reject(new DomainError("forbidden", "No access to this file", { code: "stream.forbidden" }));
		try {
			expect(await downloadsService.queueSeason("profile-1", { seasonId: "season-1" }, assertAccess)).toEqual({
				results: [{ id: "ep-1", ok: false, code: "stream.forbidden" }],
			});
			expect(insert).not.toHaveBeenCalled();
		} finally {
			restoreSeason.restore();
			restoreEpisodes.restore();
		}
	});
});

describe("DownloadsService.reconcileOnStartup", () => {
	test("re-enqueues stale rows and fails ones whose source is gone", async () => {
		findByStatuses.mockResolvedValue([
			row({ id: "dl-a", status: "processing" }),
			row({ id: "dl-b", status: "pending", mediaFileId: "file-gone" }),
		]);
		findByPrimaryId.mockResolvedValueOnce(mediaFile).mockResolvedValueOnce(undefined);

		expect(await downloadsService.reconcileOnStartup()).toBe(1);
		expect(update).toHaveBeenCalledWith("dl-a", expect.objectContaining({ status: "pending" }));
		expect(update).toHaveBeenCalledWith("dl-b", expect.objectContaining({ status: "failed" }));
		expect(addItem).toHaveBeenCalledWith("downloads-process", { downloadId: "dl-a" }, expect.objectContaining({ dedupeKey: "dl-a" }));
	});
});

describe("DownloadsService.sweepExpired", () => {
	test("retention disabled is a no-op", async () => {
		systemSettingsStore.setRuntimeValue("downloads.retentionDays", 0);
		expect(await downloadsService.sweepExpired()).toEqual({ removed: 0 });
		expect(findExpired).not.toHaveBeenCalled();
	});

	test("sweeps expired rows in pages until a short page arrives", async () => {
		systemSettingsStore.setRuntimeValue("downloads.retentionDays", 14);
		const bigPage = Array.from({ length: 500 }, (_, i) => row({ id: `dl-${i}`, fileName: null }));
		findExpired.mockResolvedValueOnce(bigPage).mockResolvedValueOnce([row({ id: "dl-old", fileName: "movie.mp4" })]);

		expect(await downloadsService.sweepExpired()).toEqual({ removed: 501 });
		expect(findExpired).toHaveBeenCalledTimes(2);
		expect(deleteRow).toHaveBeenCalledWith("dl-0");
		expect(deleteRow).toHaveBeenCalledWith("dl-old");
	});
});

// The settings store is process-global — never leak overrides into other test files.
afterEach(() => systemSettingsStore.clearRuntimeValues());

describe("DownloadsService retry and quota", () => {
	test("retrying a failed download queues a new job and drops the old row", async () => {
		findById.mockResolvedValue(row({ status: "failed" }));
		insert.mockResolvedValue(row({ id: "dl-2" }));
		findPending.mockResolvedValueOnce([row({ id: "dl-2" })]);

		const view = await downloadsService.retryForProfile("dl-1", "profile-1");

		expect(view.id).toBe("dl-2");
		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ profileId: "profile-1", mediaFileId: "file-1", quality: "720p-mobile" }));
		expect(addItem).toHaveBeenCalledWith("downloads-process", { downloadId: "dl-2" }, expect.objectContaining({ dedupeKey: "dl-2" }));
		expect(deleteRow).toHaveBeenCalledWith("dl-1");
	});

	test("only failed or cancelled downloads can be retried", async () => {
		findById.mockResolvedValue(row({ status: "completed" }));

		await expect(downloadsService.retryForProfile("dl-1", "profile-1")).rejects.toMatchObject({
			code: "downloads.not_retryable",
			category: "conflict",
		});
		expect(insert).not.toHaveBeenCalled();
	});

	test("the list carries the storage quota next to the jobs", async () => {
		storageUsed.mockResolvedValue(42);

		const listing = await downloadsService.list("profile-1");

		expect(listing.quota).toEqual({ usedBytes: 42, maxBytes: serverConfig.downloads.maxStorageBytesPerProfile });
	});
});

describe("DownloadsService.listAllPage", () => {
	test("pages every profile's downloads with the status filter and the counts per status", async () => {
		const page = spyOn(downloadsRepository, "findPage").mockResolvedValue({ data: [row({ status: "failed" })], total: 7 });
		const counts = spyOn(downloadsRepository, "countByStatus").mockResolvedValue({
			pending: 1,
			processing: 2,
			completed: 3,
			failed: 4,
			cancelled: 5,
		});

		try {
			const listing = await downloadsService.listAllPage({ page: 2, limit: 3, status: "failed" });

			expect(page).toHaveBeenCalledWith({ status: "failed", limit: 3, offset: 3 });
			expect(listing).toMatchObject({ page: 2, limit: 3, total: 7, totalPages: 3, counts: { failed: 4, cancelled: 5 } });
			expect(listing.data[0]).toMatchObject({ id: "dl-1", profileId: "profile-1" });
		} finally {
			page.mockRestore();
			counts.mockRestore();
		}
	});
});
