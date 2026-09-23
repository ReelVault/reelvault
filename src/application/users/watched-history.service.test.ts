import { describe, expect, test } from "bun:test";
import { watchedHistoryService } from "./watched-history.service";

describe("WatchedHistoryService getInsights", () => {
	test("throws UnauthorizedError when profileId is missing", async () => {
		await expect(watchedHistoryService.getInsights("30d", undefined)).rejects.toThrow("Active profile required");
	});
});
