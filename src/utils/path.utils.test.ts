import { describe, expect, test } from "bun:test";
import { PathUtils } from "./path.utils";

describe("PathUtils.isSubpath", () => {
	test("returns true for a direct child file", () => {
		expect(PathUtils.isSubpath("/home/user/subtitles/movie.vtt", "/home/user/subtitles")).toBe(true);
	});

	test("returns true for a deeply nested child file", () => {
		expect(PathUtils.isSubpath("/home/user/subtitles/nested/dir/movie.vtt", "/home/user/subtitles")).toBe(true);
	});

	test("returns false when candidate is the parent directory itself", () => {
		expect(PathUtils.isSubpath("/home/user/subtitles", "/home/user/subtitles")).toBe(false);
	});

	test("returns false for a sibling directory with similar prefix", () => {
		expect(PathUtils.isSubpath("/home/user/subtitles-other/movie.vtt", "/home/user/subtitles")).toBe(false);
	});

	test("returns false for a parent directory escaping via dot-dot traversal", () => {
		expect(PathUtils.isSubpath("/home/user/subtitles/../secret.txt", "/home/user/subtitles")).toBe(false);
	});

	test("returns false for an entirely different path", () => {
		expect(PathUtils.isSubpath("/var/log/app.log", "/home/user/subtitles")).toBe(false);
	});

	test("handles a filesystem-root parent without collapsing to a double separator", () => {
		expect(PathUtils.isSubpath("/var/log/app.log", "/")).toBe(true);
		expect(PathUtils.isSubpath("/", "/")).toBe(true);
	});
});

describe("PathUtils.getFileNameWithoutExt", () => {
	test("extracts name without extension", () => {
		expect(PathUtils.getFileNameWithoutExt("/media/movies/Avatar (2009).mkv")).toBe("Avatar (2009)");
		expect(PathUtils.getFileNameWithoutExt("archive.tar.gz")).toBe("archive.tar");
		expect(PathUtils.getFileNameWithoutExt("/path/to/noextension")).toBe("noextension");
	});
});

describe("PathUtils.normalize", () => {
	test("normalizes multiple slashes and backslashes to single forward slash", () => {
		expect(PathUtils.normalize("C:\\media\\\\movies\\file.mkv")).toBe("C:/media/movies/file.mkv");
		expect(PathUtils.normalize("/var///log////app.log")).toBe("/var/log/app.log");
		expect(PathUtils.normalize("path/to//something")).toBe("path/to/something");
	});
});
