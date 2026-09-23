import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseSidecarSnapshotResolver, episodeSnapshot, seasonSnapshot } from "./sidecar-snapshot-resolver";

/** Replaces a method on the live singleton for one test.
 * Works on real repositories AND on the minimal facades other test files
 * install with bun's process-global mock.module(...). */
function stubMethod(target: object, method: string, impl: (...args: unknown[]) => unknown): { restore(): void } {
	const original = Reflect.get(target, method);
	Reflect.set(target, method, (...args: unknown[]) => impl(...args));

	return {
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

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

describe("DatabaseSidecarSnapshotResolver", () => {
	test("throws NotFoundError for missing metadata/season/episode rows", async () => {
		const resolver = new DatabaseSidecarSnapshotResolver();
		const metadata = await import("@/database/repositories/metadata.repository");
		const seasons = await import("@/database/repositories/seasons.repository");
		const episodes = await import("@/database/repositories/episodes.repository");
		activeStubs.push(
			stubMethod(metadata.metadataRepository, "findById", () => Promise.resolve(undefined)),
			stubMethod(seasons.seasonsRepository, "findByPrimaryId", () => Promise.resolve(undefined)),
			stubMethod(episodes.episodesRepository, "findByPrimaryId", () => Promise.resolve(undefined)),
		);

		await expect(resolver.metadata("m-404")).rejects.toThrow("m-404");
		await expect(resolver.season("s-404")).rejects.toThrow("s-404");
		await expect(resolver.episode("e-404")).rejects.toThrow("e-404");
	});
});
