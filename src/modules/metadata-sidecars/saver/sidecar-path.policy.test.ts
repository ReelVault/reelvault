import { describe, expect, test } from "bun:test";
import { getSidecarPathPolicy, KodiPathPolicy, ReelVaultPathPolicy } from "./sidecar-path.policy";

describe("ReelVaultPathPolicy", () => {
	test("builds sidecar paths inside the media directory", () => {
		expect(ReelVaultPathPolicy.movie("/media/movie")).toBe("/media/movie/movie.reelvault.nfo");
		expect(ReelVaultPathPolicy.series("/media/show")).toBe("/media/show/tvshow.reelvault.nfo");
		expect(ReelVaultPathPolicy.season("/media/show", 3)).toBe("/media/show/season03-reelvault.nfo");
		expect(ReelVaultPathPolicy.episode("/media/show", "Show.S01E01")).toBe("/media/show/Show.S01E01.reelvault.nfo");
	});

	test("rejects an empty episode base name or one containing a path separator", () => {
		const invalid = expect.objectContaining({ category: "validation", code: "sidecar.path_invalid" });
		expect(() => ReelVaultPathPolicy.episode("/media/show", "../evil")).toThrow(invalid);
		expect(() => ReelVaultPathPolicy.episode("/media/show", "a/b")).toThrow(invalid);
		expect(() => ReelVaultPathPolicy.episode("/media/show", String.raw`a\b`)).toThrow(invalid);
		expect(() => ReelVaultPathPolicy.episode("/media/show", "")).toThrow(invalid);
	});
});

describe("KodiPathPolicy", () => {
	test("builds the standard NFO names Kodi, Plex and Jellyfin look for", () => {
		expect(KodiPathPolicy.movie("/media/movie")).toBe("/media/movie/movie.nfo");
		expect(KodiPathPolicy.series("/media/show")).toBe("/media/show/tvshow.nfo");
		expect(KodiPathPolicy.season("/media/show", 3)).toBe("/media/show/season03.nfo");
		expect(KodiPathPolicy.episode("/media/show", "Show.S01E01")).toBe("/media/show/Show.S01E01.nfo");
	});
});

describe("getSidecarPathPolicy", () => {
	test("selects the Kodi policy for kodi and the ReelVault policy for reelvault", () => {
		expect(getSidecarPathPolicy("kodi").movie("/media/movie")).toBe("/media/movie/movie.nfo");
		expect(getSidecarPathPolicy("reelvault").movie("/media/movie")).toBe("/media/movie/movie.reelvault.nfo");
	});
});
