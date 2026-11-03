import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { isWatcherPathSuppressed, suppressWatcherPath } from "./watcher-write-suppression.utils";

afterEach(() => {
	setSystemTime();
});

describe("watcher write suppression", () => {
	test("suppresses only the written path and only until its deadline", () => {
		setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		suppressWatcherPath("/media/movies/movie.nfo", 20);

		expect(isWatcherPathSuppressed("/media/movies/movie.nfo")).toBeTrue();
		expect(isWatcherPathSuppressed("/media/movies/poster.jpg")).toBeFalse();

		setSystemTime(new Date("2026-01-01T00:00:00.021Z"));
		expect(isWatcherPathSuppressed("/media/movies/movie.nfo")).toBeFalse();
	});
});
