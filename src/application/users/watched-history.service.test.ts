import { afterEach, describe, expect, test } from "bun:test";
import { mediaRepository } from "@/database/repositories/media-files.repository";
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

	test("marking an already fully watched file again is a no-op", async () => {
		let syncCalls = 0;
		activeStubs.push(
			stubMethod(mediaRepository, "findByIdForRead", () => Promise.resolve({ id: "file-1" })),
			stubMethod(watchedHistoryRepository, "hasFullWatch", () => Promise.resolve(true)),
			stubMethod(watchedHistoryRepository, "sync", () => {
				syncCalls += 1;

				return Promise.resolve();
			}),
		);

		await watchedHistoryService.sync({ mediaFileId: "file-1", isFullWatch: true }, "profile-1");

		expect(syncCalls).toBe(0);
	});
});
