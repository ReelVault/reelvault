import { afterEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { getFileNameWithoutExt, isSubpath, isVideoFile, normalizePath, resolveWithin } from "./path.utils";

// The settings store is process-global — never leak overrides into other tests.
afterEach(() => systemSettingsStore.clearRuntimeValues());

describe("isVideoFile", () => {
	test("classifies by the configured extension list", () => {
		expect(isVideoFile("/media/movie.mkv")).toBe(true);
		expect(isVideoFile("/media/movie.MP4")).toBe(true);
		expect(isVideoFile("/media/notes.txt")).toBe(false);
	});

	test("picks up extension-list changes without a restart", () => {
		expect(isVideoFile("/media/clip.custom")).toBe(false);

		systemSettingsStore.setRuntimeValue("scanning.supportedVideoExtensions", [".custom"]);
		expect(isVideoFile("/media/clip.custom")).toBe(true);
		expect(isVideoFile("/media/movie.mkv")).toBe(false);

		systemSettingsStore.clearRuntimeValues();
		expect(isVideoFile("/media/movie.mkv")).toBe(true);
		expect(isVideoFile("/media/clip.custom")).toBe(false);
	});
});

describe("isSubpath", () => {
	test("returns true for a direct child file", () => {
		expect(isSubpath("/home/user/subtitles/movie.vtt", "/home/user/subtitles")).toBe(true);
	});

	test("returns true for a deeply nested child file", () => {
		expect(isSubpath("/home/user/subtitles/nested/dir/movie.vtt", "/home/user/subtitles")).toBe(true);
	});

	test("returns false when candidate is the parent directory itself", () => {
		expect(isSubpath("/home/user/subtitles", "/home/user/subtitles")).toBe(false);
	});

	test("returns false for a sibling directory with similar prefix", () => {
		expect(isSubpath("/home/user/subtitles-other/movie.vtt", "/home/user/subtitles")).toBe(false);
	});

	test("returns false for a parent directory escaping via dot-dot traversal", () => {
		expect(isSubpath("/home/user/subtitles/../secret.txt", "/home/user/subtitles")).toBe(false);
	});

	test("returns false for an entirely different path", () => {
		expect(isSubpath("/var/log/app.log", "/home/user/subtitles")).toBe(false);
	});

	test("keeps a filesystem-root parent without a double separator", () => {
		expect(isSubpath("/var/log/app.log", "/")).toBe(true);
		expect(isSubpath("/", "/")).toBe(true);
	});
});

describe("resolveWithin", () => {
	test("resolves a name under the root and refuses parent traversal", () => {
		expect(resolveWithin("/var/log", "app.log")).toBe("/var/log/app.log");
		expect(resolveWithin("/var/log", "../etc/passwd")).toBeUndefined();
	});
});

describe("getFileNameWithoutExt", () => {
	test("extracts name without extension", () => {
		expect(getFileNameWithoutExt("/media/movies/Avatar (2009).mkv")).toBe("Avatar (2009)");
		expect(getFileNameWithoutExt("archive.tar.gz")).toBe("archive.tar");
		expect(getFileNameWithoutExt("/path/to/noextension")).toBe("noextension");
	});
});

describe("normalizePath", () => {
	test("normalizes multiple slashes and backslashes to single forward slash", () => {
		expect(normalizePath(String.raw`C:\media\\movies\file.mkv`)).toBe("C:/media/movies/file.mkv");
		expect(normalizePath("/var///log////app.log")).toBe("/var/log/app.log");
		expect(normalizePath("path/to//something")).toBe("path/to/something");
	});
});
