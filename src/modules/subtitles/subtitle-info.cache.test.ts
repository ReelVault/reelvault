import { describe, expect, test } from "bun:test";
import { NotFoundError } from "@/utils/errors";
import { type SubtitleContentInfo, SubtitleInfoCache } from "./subtitle-info.cache";

interface Overrides {
	rows?: Map<string, { type: string; mediaFileId: string; streamIndex: number | null; format: string }>;
	mediaPaths?: Map<string, string>;
	missingMedia?: Set<string>;
}

function createCache(overrides: Overrides = {}) {
	const rows = overrides.rows ?? new Map();
	const mediaPaths = overrides.mediaPaths ?? new Map();
	const missingMedia = overrides.missingMedia ?? new Set();
	const calls = { findSubtitle: 0, findMediaFilePath: 0 };
	const cache = new SubtitleInfoCache({
		findSubtitle: (id) => {
			calls.findSubtitle++;

			return Promise.resolve(rows.get(id));
		},
		findMediaFilePath: (mediaFileId) => {
			calls.findMediaFilePath++;
			if (missingMedia.has(mediaFileId)) return Promise.resolve(null);

			return Promise.resolve(mediaPaths.get(mediaFileId) ?? null);
		},
	});

	return { cache, calls };
}

describe("SubtitleInfoCache", () => {
	test("loads embedded info together with the media file path", async () => {
		const { cache } = createCache({
			rows: new Map([["sub-1", { type: "embedded", mediaFileId: "file-1", streamIndex: 2, format: "subrip" }]]),
			mediaPaths: new Map([["file-1", "/media/movie.mkv"]]),
		});

		expect(await cache.getOrSet("sub-1")).toEqual({
			type: "embedded",
			mediaFileId: "file-1",
			streamIndex: 2,
			format: "subrip",
			mediaFilePath: "/media/movie.mkv",
		});
	});

	test("loads external info without touching the media file repository", async () => {
		const { cache, calls } = createCache({
			rows: new Map([["sub-2", { type: "external", mediaFileId: "file-1", streamIndex: null, format: "srt" }]]),
		});

		const info: SubtitleContentInfo = await cache.getOrSet("sub-2");

		expect(info.mediaFilePath).toBeUndefined();
		expect(calls.findMediaFilePath).toBe(0);
	});

	test("throws not found for a missing subtitle", () => {
		const { cache } = createCache();

		expect(cache.getOrSet("missing")).rejects.toThrow("Subtitle not found: missing");
		expect(cache.getOrSet("missing")).rejects.toBeInstanceOf(NotFoundError);
	});

	test("throws not found when an embedded subtitle has no media file", () => {
		const { cache } = createCache({
			rows: new Map([["sub-3", { type: "embedded", mediaFileId: "gone", streamIndex: 1, format: "subrip" }]]),
			missingMedia: new Set(["gone"]),
		});

		expect(cache.getOrSet("sub-3")).rejects.toThrow("Media file not found: gone");
	});

	test("loads each subtitle once for repeated reads", async () => {
		const { cache, calls } = createCache({
			rows: new Map([["sub-4", { type: "external", mediaFileId: "file-1", streamIndex: null, format: "srt" }]]),
		});

		await cache.getOrSet("sub-4");
		await cache.getOrSet("sub-4");

		expect(calls.findSubtitle).toBe(1);
	});

	test("reloads after an invalidation", async () => {
		const { cache, calls } = createCache({
			rows: new Map([["sub-5", { type: "external", mediaFileId: "file-1", streamIndex: null, format: "srt" }]]),
		});

		await cache.getOrSet("sub-5");
		cache.invalidate("sub-5");
		await cache.getOrSet("sub-5");

		expect(calls.findSubtitle).toBe(2);
	});
});
