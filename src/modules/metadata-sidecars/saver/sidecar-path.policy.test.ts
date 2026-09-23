import { describe, expect, test } from "bun:test";
import { getSidecarPathPolicy, KodiPathPolicy, ReelVaultPathPolicy } from "./sidecar-path.policy";

describe("ReelVaultPathPolicy", () => {
	test("builds sidecar paths inside the media directory", () => {
		expect(ReelVaultPathPolicy.movie("/media/movie")).toBe("/media/movie/movie.reelvault.nfo");
		expect(ReelVaultPathPolicy.series("/media/show")).toBe("/media/show/tvshow.reelvault.nfo");
		expect(ReelVaultPathPolicy.season("/media/show", 3)).toBe("/media/show/season03-reelvault.nfo");
		expect(ReelVaultPathPolicy.episode("/media/show", "Show.S01E01")).toBe("/media/show/Show.S01E01.reelvault.nfo");
	});

	test("rejects an episode base name containing path separators or traversal", () => {
		expect(() => ReelVaultPathPolicy.episode("/media/show", "../evil")).toThrow();
		expect(() => ReelVaultPathPolicy.episode("/media/show", "a/b")).toThrow();
		expect(() => ReelVaultPathPolicy.episode("/media/show", "a\\b")).toThrow();
		expect(() => ReelVaultPathPolicy.episode("/media/show", "")).toThrow();
	});
});

describe("KodiPathPolicy", () => {
	test("builds the standard NFO names read back by Kodi, Plex and Jellyfin", () => {
		expect(KodiPathPolicy.movie("/media/movie")).toBe("/media/movie/movie.nfo");
		expect(KodiPathPolicy.series("/media/show")).toBe("/media/show/tvshow.nfo");
		expect(KodiPathPolicy.season("/media/show", 3)).toBe("/media/show/season03.nfo");
		expect(KodiPathPolicy.episode("/media/show", "Show.S01E01")).toBe("/media/show/Show.S01E01.nfo");
	});

	test("rejects an episode base name containing path separators or traversal", () => {
		expect(() => KodiPathPolicy.episode("/media/show", "../evil")).toThrow();
		expect(() => KodiPathPolicy.episode("/media/show", "a/b")).toThrow();
	});
});

describe("getSidecarPathPolicy", () => {
	test("selects the policy for the flavor and falls back to the native one", () => {
		expect(getSidecarPathPolicy("kodi").movie("/media/movie")).toBe("/media/movie/movie.nfo");
		expect(getSidecarPathPolicy("reelvault").movie("/media/movie")).toBe("/media/movie/movie.reelvault.nfo");
	});
});
