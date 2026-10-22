import { describe, expect, test } from "bun:test";
import { episodeSnapshot, seasonSnapshot } from "./sidecar-snapshot.builder";

describe("seasonSnapshot / episodeSnapshot builders", () => {
	test("season snapshot uses the stored name and slices the year from the air date", () => {
		const snapshot = seasonSnapshot({
			name: "Season One",
			seasonNumber: 1,
			airDate: "2019-03-15",
			overview: "The beginning",
			status: "released",
		});

		expect(snapshot.title).toBe("Season One");
		expect(snapshot.releaseDate).toBe("2019-03-15");
		expect(snapshot.year).toBe(2019);
		expect(snapshot.overview).toBe("The beginning");
		expect(snapshot.status).toBe("released");
		expect(snapshot.identifiers).toEqual({});
		expect(snapshot.seasonNumber).toBe(1);
	});

	test("season snapshot falls back to `Season <n>` when the name is missing", () => {
		const snapshot = seasonSnapshot({ name: null, seasonNumber: 3, airDate: null });
		expect(snapshot.title).toBe("Season 3");
		expect(snapshot.year).toBeUndefined();
		expect(snapshot.overview).toBeUndefined();
		expect(snapshot.status).toBeUndefined();
	});

	test("episode snapshot falls back to `Episode <n>` and has no status", () => {
		const snapshot = episodeSnapshot({ title: null, episodeNumber: 7, airDate: "2020-01-02" });
		expect(snapshot.title).toBe("Episode 7");
		expect(snapshot.year).toBe(2020);
		expect(snapshot.episodeNumber).toBe(7);
		expect(snapshot.seasonNumber).toBeUndefined();

		const placed = episodeSnapshot({ title: "Pilot", seasonNumber: 2, episodeNumber: 1, airDate: null });
		expect(placed.title).toBe("Pilot");
		expect(placed.year).toBeUndefined();
		expect(placed.status).toBeUndefined();
		expect(placed.seasonNumber).toBe(2);
	});

	test("malformed dates do not produce a year", () => {
		const snapshot = seasonSnapshot({ name: "S", seasonNumber: 1, airDate: "not-a-date" });
		expect(snapshot.year).toBeUndefined();
	});
});
