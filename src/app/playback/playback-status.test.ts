import { describe, expect, test } from "bun:test";
import { getPlaybackItemStatus } from "./playback-status.reader";

describe("playback item status", () => {
	test("uses the most recently updated version", () => {
		expect(
			getPlaybackItemStatus([
				{
					mediaFileId: "streaming",
					position: 600,
					duration: 1200,
					completed: false,
					updatedAt: "2026-01-02T00:00:00.000Z",
				},
				{
					mediaFileId: "disc",
					position: 1200,
					duration: 1200,
					completed: true,
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			]),
		).toMatchObject({ status: "in_progress", progress: { mediaFileId: "streaming" } });
	});

	test("reports unwatched while the position is still zero", () => {
		expect(
			getPlaybackItemStatus([
				{
					mediaFileId: "file",
					position: 0,
					duration: 1200,
					completed: false,
					updatedAt: new Date().toISOString(),
				},
			]),
		).toEqual({
			status: "unwatched",
			progress: expect.anything(),
		});
	});
});
