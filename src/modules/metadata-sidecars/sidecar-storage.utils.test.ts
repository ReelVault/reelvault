import { describe, expect, test } from "bun:test";
import type { SidecarStorageLibrary } from "./sidecar-metadata-storage.service";
import { resolveMetadataStorageMode, resolveSeriesDirectory, usesSidecars } from "./sidecar-storage.utils";

const library: SidecarStorageLibrary = {
	metadataStorageMode: "database",
	paths: [
		{ path: "/media", metadataStorageMode: "sidecar" },
		{ path: "/media/private", metadataStorageMode: "database" },
		{ path: "/media/mixed", metadataStorageMode: null },
	],
};

describe("resolveMetadataStorageMode", () => {
	test("uses the most specific matching library path", () => {
		expect(resolveMetadataStorageMode(library, "/media/movie/movie.mkv")).toBe("sidecar");
		expect(resolveMetadataStorageMode(library, "/media/private/movie/movie.mkv")).toBe("database");
	});

	test("a null path mode falls back to the library default", () => {
		expect(resolveMetadataStorageMode(library, "/media/mixed/movie/movie.mkv")).toBe("database");
	});

	test("a file outside every path uses the library default", () => {
		expect(resolveMetadataStorageMode(library, "/other/movie/movie.mkv")).toBe("database");
	});

	test("a file directly inside a library root matches that root", () => {
		expect(resolveMetadataStorageMode(library, "/media/movie.mkv")).toBe("sidecar");
	});
});

describe("resolveSeriesDirectory", () => {
	test("returns the episode directory's parent for episode folders under a library path", () => {
		expect(resolveSeriesDirectory(library.paths, "/media/show/Season 01")).toBe("/media/show");
	});

	test("the library root itself is the series directory", () => {
		expect(resolveSeriesDirectory(library.paths, "/media")).toBe("/media");
	});

	test("a directory outside every path yields the parent directory", () => {
		expect(resolveSeriesDirectory(library.paths, "/elsewhere/show/Season 01")).toBe("/elsewhere/show");
	});
});

describe("usesSidecars", () => {
	test("only sidecar and database_and_sidecar modes use sidecars", () => {
		expect(usesSidecars("sidecar")).toBeTrue();
		expect(usesSidecars("database_and_sidecar")).toBeTrue();
		expect(usesSidecars("database")).toBeFalse();
	});
});
