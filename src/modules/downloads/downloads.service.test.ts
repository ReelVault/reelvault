import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { MediaFileWithRelation } from "@sdk/common/media-file.types";
import { spawn } from "bun";
import { systemSettingsStore } from "@/config/system-settings.store";
import { type DownloadRow, downloadsRepository } from "@/database/repositories/downloads.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { FFmpegBuilder } from "@/integrations/ffmpeg/ffmpeg.builder";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { serverConfig } from "@/server.config";
import { FileUtils } from "@/utils/file.utils";
import { createMockWorkerItem } from "@/workers/core/worker-runtime.test-utils";
import { workerService } from "@/workers/worker.service";
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
const countActive = spyOn(downloadsRepository, "countActiveByProfile").mockResolvedValue(0);
const storageUsed = spyOn(downloadsRepository, "storageUsedByProfile").mockResolvedValue(0);
const findExpired = spyOn(downloadsRepository, "findExpired").mockResolvedValue([]);
const findByProfile = spyOn(downloadsRepository, "findByProfile").mockResolvedValue([]);
const addItem = spyOn(workerService, "addItem").mockResolvedValue(createMockWorkerItem({ id: "job-1" }));

beforeEach(() => {
	findByPrimaryId.mockClear().mockResolvedValue(mediaFile);
	insert.mockClear().mockResolvedValue(row());
	findById.mockClear().mockResolvedValue(undefined);
	update.mockClear();
	deleteRow.mockClear();
	countActive.mockClear().mockResolvedValue(0);
	storageUsed.mockClear().mockResolvedValue(0);
	findExpired.mockClear().mockResolvedValue([]);
	findByProfile.mockClear().mockResolvedValue([]);
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
		await expect(downloadsService.prepare("profile-1", "file-1")).rejects.toThrow("Downloads are disabled");
		systemSettingsStore.clearRuntimeValues();

		await expect(downloadsService.prepare(undefined, "file-1")).rejects.toThrow("Profile not found");
		await expect(downloadsService.prepare("profile-1", "  ")).rejects.toThrow("mediaFileId is required");
		findByPrimaryId.mockResolvedValueOnce(undefined);
		await expect(downloadsService.prepare("profile-1", "file-missing")).rejects.toThrow("file-missing");
		findByPrimaryId.mockResolvedValue(createMockMediaFile({ duration: 0 }));
		await expect(downloadsService.prepare("profile-1", "file-1", "1080p-desktop")).rejects.toThrow("known file duration");

		// "original" skips the duration gate.
		await downloadsService.prepare("profile-1", "file-1", "original");
		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ quality: "original" }));
	});

	test("enforces the per-profile active quota and storage quota", async () => {
		countActive.mockResolvedValue(1);
		await expect(downloadsService.prepare("profile-1", "file-1")).rejects.toThrow("already has a download in progress");
		countActive.mockResolvedValue(0);

		storageUsed.mockResolvedValue(100);
		systemSettingsStore.setRuntimeValue("downloads.maxStorageBytesPerProfile", 100);
		await expect(downloadsService.prepare("profile-1", "file-1")).rejects.toThrow("Storage quota exceeded");
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

		expect(update).toHaveBeenCalledWith("dl-1", expect.objectContaining({ status: "failed", errorText: "FFmpeg produced an empty file" }));
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
		expect(update).toHaveBeenCalledWith("dl-1", expect.objectContaining({ status: "processing" }));
		expect(update).not.toHaveBeenCalledWith("dl-1", expect.objectContaining({ status: "completed" }));
		expect(await FileUtils.exists(fake.outputPath)).toBe(false);
		fake.spy.mockRestore();
	});

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

	test("missing media file fails the job lookup", async () => {
		findById.mockResolvedValue(row());
		findByPrimaryId.mockResolvedValue(undefined);
		await expect(downloadsService.process("dl-1")).rejects.toThrow("Media file not found");
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
