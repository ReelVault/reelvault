import { describe, expect, test } from "bun:test";
import { selectNextEpisodeFileInSeries } from "./smart-play.resolver";

const updatedAt = new Date("2026-01-01T00:00:00.000Z");

describe("next episode order follows the show's numbering", () => {
	// Season order is a, b, c; absolute order is c (1), a (2), b (3). The current episode is b.
	const episodes = [
		{ id: "ep-a", seasonId: "s-1", episodeNumber: 1, absoluteNumber: 2 },
		{ id: "ep-b", seasonId: "s-1", episodeNumber: 2, absoluteNumber: 3 },
		{ id: "ep-c", seasonId: "s-1", episodeNumber: 3, absoluteNumber: 1 },
	];
	const seasons = [{ id: "s-1", seasonNumber: 1 }];
	const mediaFiles = [
		{ id: "f-a", episodeId: "ep-a", isDefault: false, updatedAt },
		{ id: "f-b", episodeId: "ep-b", isDefault: false, updatedAt },
		{ id: "f-c", episodeId: "ep-c", isDefault: false, updatedAt },
	];
	const current = { id: "ep-b", seasonId: "s-1" };

	test("a seasonal show continues with the episode after it in season order", () => {
		expect(selectNextEpisodeFileInSeries(episodes, seasons, mediaFiles, current, "seasonal")).toBe("f-c");
	});

	test("an absolute-numbered show has no later episode once its last absolute number is reached", () => {
		expect(selectNextEpisodeFileInSeries(episodes, seasons, mediaFiles, current, "absolute")).toBeNull();
	});
});
