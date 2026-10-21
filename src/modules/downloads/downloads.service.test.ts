import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { systemSettingsStore } from "@/config/system-settings.store";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { FFmpegBuilder } from "@/integrations/ffmpeg/ffmpeg.builder";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { downloadsRepository } from "@/repositories/downloads.repository";
import { removeTreeSync } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { fileExists } from "@/utils/file.utils";
import { detach } from "@/utils/promise.utils";
import { downloadsProcessWorker } from "@/workers/definitions/downloads/downloads-process.worker";
import { workerService } from "@/workers/worker.service";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { downloadsService } from "./downloads.service";

type DownloadInsert = typeof schema.downloads.$inferInsert;

const DAY_MS = 24 * 60 * 60 * 1000;
const allowAccess = () => Promise.resolve();

const db = useTestDatabase();
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(async () => {
	workerService.registry.register(downloadsProcessWorker);
	await seedLibrary();
});

afterEach(() => {
	workerService.registry.unregister(downloadsProcessWorker.id);
	for (const spy of spies.splice(0)) spy.mockRestore();
	removeTreeSync(serverConfig.paths.downloads);
	// The settings store is process-global — never leak overrides into other test files.
	systemSettingsStore.clearRuntimeValues();
});

/** Two profiles, one movie with several media files: one per situation the downloads can be in. */
async function seedLibrary(): Promise<void> {
	const client = db.client();
	await client.insert(schema.users).values({ id: "user-1", name: "Ann", email: "ann@example.com", emailVerified: true });
	await client.insert(schema.profiles).values([
		{ id: "profile-1", userId: "user-1", name: "Ann" },
		{ id: "profile-2", userId: "user-1", name: "Ben" },
	]);
	await client.insert(schema.libraries).values({ id: "lib-1", name: "Movies", type: "movies" });
	await client
		.insert(schema.metadata)
		.values({ id: "meta-1", stableKey: "movie-heat", title: "Heat", type: "movie", releaseDate: "1995-12-15" });
	await client.insert(schema.movies).values({ id: "movie-1", stableKey: "movie-heat", metadataId: "meta-1" });

	const movieFile = { libraryId: "lib-1", metadataId: "meta-1", movieId: "movie-1", size: 1_000, isDefault: false };
	await client.insert(schema.mediaFiles).values([
		{ ...movieFile, id: "file-1", fileName: "My.Movie.mkv", filePath: "/media/movie.mkv", duration: 3_600, isDefault: true },
		{ ...movieFile, id: "file-2", fileName: "Other.mkv", filePath: "/media/other.mkv", duration: 3_600 },
		{ ...movieFile, id: "file-3", fileName: "Third.mkv", filePath: "/media/third.mkv", duration: 3_600 },
		{ ...movieFile, id: "file-bad", fileName: 'Bad:Name?*"<>.mkv', filePath: "/media/bad.mkv", duration: 3_600 },
		{ ...movieFile, id: "file-no-duration", fileName: "Clip.mkv", filePath: "/media/clip.mkv", duration: 0 },
		{ ...movieFile, id: "file-no-path", fileName: "Gone.mkv", filePath: "", duration: 3_600 },
	]);
}

async function seedSeason(): Promise<void> {
	const client = db.client();
	await client
		.insert(schema.metadata)
		.values({ id: "show-1", stableKey: "show-heat", title: "Show", type: "tv_show", releaseDate: "2000-01-01" });
	await client.insert(schema.seasons).values([
		{ id: "season-1", stableKey: "show-1-s1", metadataId: "show-1", seasonNumber: 1 },
		{ id: "season-2", stableKey: "show-1-s2", metadataId: "show-1", seasonNumber: 2 },
	]);
	await client.insert(schema.episodes).values([
		{ id: "ep-1", stableKey: "show-1-s1e1", seasonId: "season-1", episodeNumber: 1 },
		{ id: "ep-2", stableKey: "show-1-s1e2", seasonId: "season-1", episodeNumber: 2 },
		{ id: "ep-3", stableKey: "show-1-s2e1", seasonId: "season-2", episodeNumber: 1 },
	]);
	await client.insert(schema.mediaFiles).values([
		{
			id: "ep-file-1",
			libraryId: "lib-1",
			metadataId: "show-1",
			episodeId: "ep-1",
			fileName: "e1.mkv",
			filePath: "/tv/e1.mkv",
			size: 600,
			duration: 1_500,
			isDefault: true,
		},
		{
			id: "ep-file-3",
			libraryId: "lib-1",
			metadataId: "show-1",
			episodeId: "ep-3",
			fileName: "e3.mkv",
			filePath: "/tv/e3.mkv",
			size: 900,
			duration: 1_500,
			isDefault: true,
		},
	]);
}

async function insertDownload(values: Partial<DownloadInsert> & Pick<DownloadInsert, "id">): Promise<void> {
	await db
		.client()
		.insert(schema.downloads)
		.values({ profileId: "profile-1", mediaFileId: "file-1", ...values });
}

function daysAgo(days: number): Date {
	return new Date(Date.now() - days * DAY_MS);
}

function artifactPath(downloadId: string, fileName: string): string {
	return join(serverConfig.paths.downloads, downloadId, fileName);
}

/**
 * Stands in for the ffmpeg process only. `onRun` writes the artifact (or changes the
 * row) while the process runs; the process then exits with `exitCode`.
 */
function fakeFfmpeg(exitCode: number | null, onRun?: (outputPath: string) => Promise<void> | void): void {
	let exitHandler: Parameters<FFmpegBuilder["onExit"]>[0] | undefined;

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
		override run(outputPath: string) {
			const proc = spawn({ cmd: ["true"], stdout: "ignore", stderr: "pipe" });
			detach(
				(async () => {
					await onRun?.(outputPath);
					exitHandler?.(proc, exitCode, null);
				})(),
			);

			return proc;
		}
	}

	spies.push(spyOn(ffMpegService, "create").mockImplementation(() => new FakeBuilder()));
}

describe("DownloadsService.prepare", () => {
	test("refuses every request while downloads are disabled on the server", async () => {
		systemSettingsStore.setRuntimeValue("downloads.enabled", false);

		await expect(downloadsService.prepare("profile-1", "file-1")).rejects.toMatchObject({
			code: "downloads.disabled",
			category: "forbidden",
		});
		expect(await downloadsRepository.findByProfile("profile-1")).toEqual([]);
	});

	test.each([
		{ reason: "without a profile", profileId: undefined, mediaFileId: "file-1", code: "auth.profile_required" },
		{ reason: "with a blank media file id", profileId: "profile-1", mediaFileId: "  ", code: "downloads.media_file_required" },
	])("refuses a request $reason", async ({ profileId, mediaFileId, code }) => {
		await expect(downloadsService.prepare(profileId, mediaFileId)).rejects.toMatchObject({ code });
		expect(await downloadsRepository.findByProfile("profile-1")).toEqual([]);
	});

	test("refuses a media file that is not in the library", async () => {
		await expect(downloadsService.prepare("profile-1", "file-missing")).rejects.toMatchObject({
			code: "entity.not_found",
			category: "not_found",
			params: { entityType: "MediaFile", entityId: "file-missing" },
		});
	});

	test("needs a known duration for transcoded qualities, but not for the original", async () => {
		await expect(downloadsService.prepare("profile-1", "file-no-duration")).rejects.toMatchObject({
			code: "downloads.duration_unknown",
			category: "validation",
		});

		const original = await downloadsService.prepare("profile-1", "file-no-duration", "original");

		expect(original.quality).toBe("original");
	});

	test("refuses a second copy while the profile already has one running or waiting", async () => {
		await downloadsService.prepare("profile-1", "file-1");

		await expect(downloadsService.prepare("profile-1", "file-1")).rejects.toMatchObject({
			code: "downloads.in_progress",
			category: "conflict",
		});
		expect(await downloadsRepository.findByProfile("profile-1")).toHaveLength(1);
	});

	test("refuses a request once the profile has too many downloads waiting", async () => {
		await db
			.client()
			.insert(schema.downloads)
			.values(
				Array.from({ length: 200 }, (_, index) => ({
					id: `queued-${index}`,
					profileId: "profile-1",
					mediaFileId: "file-3",
					status: "pending" as const,
				})),
			);

		await expect(downloadsService.prepare("profile-1", "file-2")).rejects.toMatchObject({
			code: "downloads.queue_full",
			category: "conflict",
		});
	});

	test("refuses a request that would exceed the profile's storage quota", async () => {
		await insertDownload({ id: "dl-done", status: "completed", sizeBytes: 100, fileName: "done.mp4" });
		systemSettingsStore.setRuntimeValue("downloads.maxStorageBytesPerProfile", 100);

		await expect(downloadsService.prepare("profile-1", "file-1")).rejects.toMatchObject({
			code: "downloads.quota_exceeded",
			category: "conflict",
		});
	});

	test("keeps a request waiting, not started, while the profile has no free running slot", async () => {
		systemSettingsStore.setRuntimeValue("downloads.maxConcurrentPerProfile", 1);
		await insertDownload({ id: "dl-running", status: "processing", mediaFileId: "file-3" });

		const view = await downloadsService.prepare("profile-1", "file-1");

		expect(view.status).toBe("pending");
		expect(await workerService.findActiveItem(downloadsProcessWorker.id, view.id)).toBeUndefined();
	});

	test("falls back to the default quality for an unknown value and queues the job", async () => {
		const view = await downloadsService.prepare("profile-1", "file-1", "8k-ultra");

		expect(view.quality).toBe("720p-mobile");
		expect(await workerService.findActiveItem(downloadsProcessWorker.id, view.id)).toMatchObject({ id: expect.any(String) });
	});
});

describe("DownloadsService job ownership", () => {
	test("shows a job to its owner only, with a download link once it is completed", async () => {
		await insertDownload({ id: "dl-1" });
		expect(await downloadsService.getJobViewForProfile("dl-1", "profile-2")).toBeNull();
		expect(await downloadsService.getJobViewForProfile("dl-1", "profile-1")).toMatchObject({ downloadUrl: null });

		await insertDownload({ id: "dl-2", status: "completed", sizeBytes: 5, fileName: "movie.mp4" });
		expect(await downloadsService.getJobViewForProfile("dl-2", "profile-1")).toMatchObject({
			downloadUrl: "/v1/downloads/dl-2/file",
		});
	});

	test("refuses to cancel or delete another profile's job and keeps the row", async () => {
		await insertDownload({ id: "dl-1" });

		await expect(downloadsService.cancelForProfile("dl-1", "profile-2")).rejects.toMatchObject({
			code: "download_not_found",
			category: "not_found",
		});
		await expect(downloadsService.deleteForProfile("dl-1", "profile-2")).rejects.toMatchObject({
			code: "download_not_found",
			category: "not_found",
		});
		expect(await downloadsRepository.findById("dl-1")).toMatchObject({ id: "dl-1", status: "pending" });
	});

	test("refuses to cancel a completed download", async () => {
		await insertDownload({ id: "dl-1", status: "completed", sizeBytes: 5, fileName: "movie.mp4" });

		await expect(downloadsService.cancelForProfile("dl-1", "profile-1")).rejects.toMatchObject({
			code: "completed_download_cancel",
			category: "validation",
		});
	});
});

describe("DownloadsService.process", () => {
	test("runs a pending download to completed and records the artifact size", async () => {
		await insertDownload({ id: "dl-1" });
		fakeFfmpeg(0, (outputPath) => writeFileSync(outputPath, "video-bytes"));

		await downloadsService.process("dl-1");

		expect(await downloadsRepository.findById("dl-1")).toMatchObject({
			status: "completed",
			progressPercent: 100,
			sizeBytes: 11,
			fileName: "My.Movie.720p-mobile.mp4",
		});
		expect(await fileExists(artifactPath("dl-1", "My.Movie.720p-mobile.mp4"))).toBe(true);
	});

	test("sanitizes characters that are illegal in file names", async () => {
		await insertDownload({ id: "dl-bad", mediaFileId: "file-bad" });
		fakeFfmpeg(0, (outputPath) => writeFileSync(outputPath, "x"));

		await downloadsService.process("dl-bad");

		expect(await downloadsRepository.findById("dl-bad")).toMatchObject({ fileName: "Bad_Name_.720p-mobile.mp4" });
	});

	test("a failed ffmpeg run marks the job failed and removes the partial file", async () => {
		await insertDownload({ id: "dl-1" });
		fakeFfmpeg(1, (outputPath) => writeFileSync(outputPath, "partial"));

		await downloadsService.process("dl-1");

		expect(await downloadsRepository.findById("dl-1")).toMatchObject({ status: "failed", errorText: "download.ffmpeg_failed" });
		expect(await fileExists(artifactPath("dl-1", "My.Movie.720p-mobile.mp4"))).toBe(false);
	});

	test("an empty artifact fails the job", async () => {
		await insertDownload({ id: "dl-1" });
		fakeFfmpeg(0, (outputPath) => writeFileSync(outputPath, ""));

		await downloadsService.process("dl-1");

		expect(await downloadsRepository.findById("dl-1")).toMatchObject({ status: "failed", errorText: "download.empty_output" });
	});

	test("a cancellation during the run keeps the job cancelled and drops the artifact", async () => {
		await insertDownload({ id: "dl-1" });
		fakeFfmpeg(0, async (outputPath) => {
			writeFileSync(outputPath, "partial");
			await downloadsRepository.update("dl-1", { status: "cancelled" });
		});

		await downloadsService.process("dl-1");

		expect(await downloadsRepository.findById("dl-1")).toMatchObject({ status: "cancelled" });
		expect(await fileExists(artifactPath("dl-1", "My.Movie.720p-mobile.mp4"))).toBe(false);
	});

	test("an artifact that would exceed the storage quota fails the job with a storage limit", async () => {
		await insertDownload({ id: "dl-done", status: "completed", sizeBytes: 95, fileName: "done.mp4" });
		await insertDownload({ id: "dl-1" });
		systemSettingsStore.setRuntimeValue("downloads.maxStorageBytesPerProfile", 100);
		fakeFfmpeg(0, (outputPath) => writeFileSync(outputPath, "0123456789"));

		await downloadsService.process("dl-1");

		expect(await downloadsRepository.findById("dl-1")).toMatchObject({ status: "failed", errorText: "download.storage_limit" });
	});

	test("a job whose media file has no path fails instead of staying pending", async () => {
		await insertDownload({ id: "dl-1", mediaFileId: "file-no-path" });

		await downloadsService.process("dl-1");

		expect(await downloadsRepository.findById("dl-1")).toMatchObject({ status: "failed", errorText: "download.media_missing" });
	});

	test("a job that is no longer pending is left untouched", async () => {
		await insertDownload({ id: "dl-1", status: "completed", sizeBytes: 5, fileName: "kept.mp4" });

		await downloadsService.process("dl-1");

		expect(await downloadsRepository.findById("dl-1")).toMatchObject({ status: "completed", sizeBytes: 5, fileName: "kept.mp4" });
	});
});

describe("DownloadsService.queueSeason", () => {
	beforeEach(seedSeason);

	test("refuses a season larger than the free space until it is forced, then queues each episode", async () => {
		systemSettingsStore.setRuntimeValue("downloads.maxStorageBytesPerProfile", 500);

		await expect(downloadsService.queueSeason("profile-1", { seasonId: "season-1" }, allowAccess)).rejects.toMatchObject({
			code: "downloads.season_exceeds_quota",
			params: { estimatedBytes: 600, freeBytes: 500 },
		});

		const { results } = await downloadsService.queueSeason("profile-1", { seasonId: "season-1", force: true }, allowAccess);

		expect(results).toHaveLength(2);
		expect(results).toEqual(
			expect.arrayContaining([
				{ id: "ep-1", ok: true },
				{ id: "ep-2", ok: false, code: "downloads.no_media_file" },
			]),
		);
		expect((await downloadsRepository.findByProfile("profile-1")).map((row) => row.mediaFileId)).toEqual(["ep-file-1"]);
	});

	test("reports an episode whose file the profile may not stream by its code and queues nothing for it", async () => {
		const denyAccess = () => Promise.reject(new DomainError("forbidden", "No access to this file", { code: "stream.forbidden" }));

		const { results } = await downloadsService.queueSeason("profile-1", { seasonId: "season-1" }, denyAccess);

		expect(results).toEqual(expect.arrayContaining([{ id: "ep-1", ok: false, code: "stream.forbidden" }]));
		expect(await downloadsRepository.findByProfile("profile-1")).toEqual([]);
	});
});

describe("DownloadsService.reconcileOnStartup", () => {
	test("re-queues interrupted jobs whose media file exists and fails the rest", async () => {
		await insertDownload({ id: "dl-a", status: "processing" });
		await insertDownload({ id: "dl-b", status: "pending", mediaFileId: "file-no-path" });

		expect(await downloadsService.reconcileOnStartup()).toBe(1);

		expect(await downloadsRepository.findById("dl-a")).toMatchObject({ status: "pending" });
		expect(await downloadsRepository.findById("dl-b")).toMatchObject({ status: "failed", errorText: "download.media_missing" });
		expect(await workerService.findActiveItem(downloadsProcessWorker.id, "dl-a")).toMatchObject({ id: expect.any(String) });
	});
});

describe("DownloadsService.sweepExpired", () => {
	test("keeps every job while retention is disabled", async () => {
		systemSettingsStore.setRuntimeValue("downloads.retentionDays", 0);
		await insertDownload({ id: "dl-old", status: "completed", sizeBytes: 5, updatedAt: daysAgo(30) });

		expect(await downloadsService.sweepExpired()).toEqual({ removed: 0 });
		expect(await downloadsRepository.findById("dl-old")).toMatchObject({ id: "dl-old" });
	});

	test("removes expired jobs with their artifacts and keeps recent ones", async () => {
		systemSettingsStore.setRuntimeValue("downloads.retentionDays", 14);
		await insertDownload({ id: "dl-old", status: "completed", sizeBytes: 5, fileName: "old.mp4", updatedAt: daysAgo(30) });
		await insertDownload({ id: "dl-new", status: "completed", sizeBytes: 5, fileName: "new.mp4", updatedAt: new Date() });
		for (const [id, fileName] of [
			["dl-old", "old.mp4"],
			["dl-new", "new.mp4"],
		] as const) {
			mkdirSync(join(serverConfig.paths.downloads, id), { recursive: true });
			writeFileSync(artifactPath(id, fileName), "x");
		}

		expect(await downloadsService.sweepExpired()).toEqual({ removed: 1 });

		expect(await downloadsRepository.findById("dl-old")).toBeUndefined();
		expect(await fileExists(artifactPath("dl-old", "old.mp4"))).toBe(false);
		expect(await downloadsRepository.findById("dl-new")).toMatchObject({ id: "dl-new" });
		expect(await fileExists(artifactPath("dl-new", "new.mp4"))).toBe(true);
	});
});

describe("DownloadsService retry and quota", () => {
	test("retrying a failed job queues a new one with the same file and quality and drops the old row", async () => {
		await insertDownload({ id: "dl-1", status: "failed", quality: "1080p-high" });

		const view = await downloadsService.retryForProfile("dl-1", "profile-1");

		expect(view).toMatchObject({ mediaFileId: "file-1", quality: "1080p-high" });
		expect(view.id).not.toBe("dl-1");
		expect(await downloadsRepository.findById("dl-1")).toBeUndefined();
		expect(await workerService.findActiveItem(downloadsProcessWorker.id, view.id)).toMatchObject({ id: expect.any(String) });
	});

	test("refuses to retry a completed download", async () => {
		await insertDownload({ id: "dl-1", status: "completed", sizeBytes: 5, fileName: "movie.mp4" });

		await expect(downloadsService.retryForProfile("dl-1", "profile-1")).rejects.toMatchObject({
			code: "downloads.not_retryable",
			category: "conflict",
		});
		expect(await downloadsRepository.findByProfile("profile-1")).toHaveLength(1);
	});

	test("the list reports the storage the profile uses", async () => {
		await insertDownload({ id: "dl-1", status: "completed", sizeBytes: 42, fileName: "movie.mp4" });

		const listing = await downloadsService.list("profile-1");

		expect(listing.quota).toEqual({ usedBytes: 42, maxBytes: serverConfig.downloads.maxStorageBytesPerProfile });
	});
});

describe("DownloadsService.listAllPage", () => {
	test("pages every profile's jobs with the status filter and counts every status", async () => {
		await insertDownload({ id: "dl-pending", status: "pending" });
		await insertDownload({ id: "dl-processing", status: "processing", profileId: "profile-2", mediaFileId: "file-2" });
		await insertDownload({ id: "dl-completed", status: "completed", sizeBytes: 5, fileName: "a.mp4", mediaFileId: "file-3" });
		await insertDownload({ id: "dl-failed-1", status: "failed", mediaFileId: "file-3" });
		await insertDownload({ id: "dl-failed-2", status: "failed", profileId: "profile-2", mediaFileId: "file-3" });
		await insertDownload({ id: "dl-cancelled", status: "cancelled", profileId: "profile-2", mediaFileId: "file-3" });

		const listing = await downloadsService.listAllPage({ page: 2, limit: 1, status: "failed" });

		expect(listing).toMatchObject({
			page: 2,
			limit: 1,
			total: 2,
			totalPages: 2,
			counts: { pending: 1, processing: 1, completed: 1, failed: 2, cancelled: 1 },
		});
		expect(listing.data).toHaveLength(1);
		expect(listing.data[0]).toMatchObject({ status: "failed" });
	});
});
