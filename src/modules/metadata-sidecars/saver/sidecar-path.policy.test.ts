import { describe, expect, test } from "bun:test";
import { getSidecarMediaKind, getSidecarPathPolicy, KodiPathPolicy, ReelVaultPathPolicy } from "./sidecar-path.policy";

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

describe("getSidecarMediaKind", () => {
	test("classifies movie, series, season and episode documents by file name", () => {
		expect(getSidecarMediaKind("/media/movie.nfo")).toBe("movie");
		expect(getSidecarMediaKind("/media/movie.reelvault.nfo")).toBe("movie");
		expect(getSidecarMediaKind("/media/show/tvshow.nfo")).toBe("series");
		expect(getSidecarMediaKind("/media/show/tvshow.reelvault.nfo")).toBe("series");
		expect(getSidecarMediaKind("/media/show/Season 01/season.nfo")).toBe("season");
		expect(getSidecarMediaKind("/media/show/Season 01/season01.nfo")).toBe("season");
		expect(getSidecarMediaKind("/media/show/Season 01/season01-reelvault.nfo")).toBe("season");
		expect(getSidecarMediaKind("/media/show/Season 01/s01e01.reelvault.nfo")).toBe("episode");
	});
});
