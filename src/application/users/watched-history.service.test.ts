import { afterEach, describe, expect, test } from "bun:test";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { playbackRepository } from "@/database/repositories/playback.repository";
import { watchedHistoryRepository } from "@/database/repositories/watched-history.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { watchedHistoryService } from "./watched-history.service";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("WatchedHistoryService getInsights", () => {
	test("throws UnauthorizedError when profileId is missing", async () => {
		await expect(watchedHistoryService.getInsights("30d", undefined)).rejects.toThrow("Active profile required");
	});
});

describe("WatchedHistoryService sync", () => {
	test("an unknown media file is a 404, not an FK violation", async () => {
		activeStubs.push(stubMethod(mediaRepository, "findByIdForRead", () => Promise.resolve(undefined)));

		await expect(watchedHistoryService.sync({ mediaFileId: "file-missing" }, "profile-1")).rejects.toMatchObject({
			code: "entity.not_found",
			params: { entityType: "MediaFile", entityId: "file-missing" },
		});
	});

	test("marking a file watched advances Continue Watching", async () => {
		let upserted: Record<string, unknown> | undefined;
		activeStubs.push(
			stubMethod(mediaRepository, "findByIdForRead", () => Promise.resolve({ id: "file-1", duration: 600 })),
			stubMethod(watchedHistoryRepository, "hasFullWatch", () => Promise.resolve(false)),
			stubMethod(watchedHistoryRepository, "sync", () => Promise.resolve()),
			stubMethod(playbackRepository, "upsertProgress", (params: Record<string, unknown>) => {
				upserted = params;

				return Promise.resolve();
			}),
		);

		await watchedHistoryService.sync({ mediaFileId: "file-1", isFullWatch: true }, "profile-1");

		expect(upserted).toMatchObject({ profileId: "profile-1", fileId: "file-1", position: 600, duration: 600, completed: true });
	});

	test("a partial watch does not mark progress completed", async () => {
		let upsertCalls = 0;
		activeStubs.push(
			stubMethod(mediaRepository, "findByIdForRead", () => Promise.resolve({ id: "file-1", duration: 600 })),
			stubMethod(watchedHistoryRepository, "sync", () => Promise.resolve()),
			stubMethod(playbackRepository, "upsertProgress", () => {
				upsertCalls += 1;

				return Promise.resolve();
			}),
		);

		await watchedHistoryService.sync({ mediaFileId: "file-1" }, "profile-1");

		expect(upsertCalls).toBe(0);
	});

	test("marking an already fully watched file again is a no-op", async () => {
		let syncCalls = 0;
		activeStubs.push(
			stubMethod(mediaRepository, "findByIdForRead", () => Promise.resolve({ id: "file-1", duration: 600 })),
			stubMethod(watchedHistoryRepository, "hasFullWatch", () => Promise.resolve(true)),
			stubMethod(watchedHistoryRepository, "sync", () => {
				syncCalls += 1;

				return Promise.resolve();
			}),
			stubMethod(playbackRepository, "upsertProgress", () => Promise.resolve()),
		);

		await watchedHistoryService.sync({ mediaFileId: "file-1", isFullWatch: true }, "profile-1");

		expect(syncCalls).toBe(0);
	});
});
