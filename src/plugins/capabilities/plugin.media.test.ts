import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { pluginMediaService } from "./plugin.media";

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	activeStubs.length = 0;
});

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
});

describe("pluginMediaService.get", () => {
	test("maps duration seconds to durationMs and marks the file available", async () => {
		activeStubs.push(
			stubMethod(mediaRepository, "findByPrimaryId", () =>
				Promise.resolve({ id: "mf-1", metadataId: "meta-1", fileName: "movie.mkv", filePath: "/media/movie.mkv", duration: 42.5 }),
			),
		);

		const result = await pluginMediaService.get("mf-1");

		expect(result).toEqual({
			id: "mf-1",
			metadataId: "meta-1",
			fileName: "movie.mkv",
			filePath: "/media/movie.mkv",
			durationMs: 42_500,
			available: true,
		});
	});

	test("omits durationMs when duration is unknown", async () => {
		activeStubs.push(
			stubMethod(mediaRepository, "findByPrimaryId", () =>
				Promise.resolve({ id: "mf-2", metadataId: "meta-1", fileName: "movie.mkv", filePath: "/media/movie.mkv", duration: null }),
			),
		);

		const result = await pluginMediaService.get("mf-2");

		expect(result?.available).toBe(true);
		expect(result?.durationMs).toBeUndefined();
	});

	test("returns null for an unknown media file", async () => {
		activeStubs.push(stubMethod(mediaRepository, "findByPrimaryId", () => Promise.resolve(undefined)));

		await expect(pluginMediaService.get("missing")).resolves.toBeNull();
	});
});

describe("pluginMediaService.getRevision", () => {
	test("projects size, mtime and default audio streams", async () => {
		activeStubs.push(
			stubMethod(mediaRepository, "findForPlaybackSession", () =>
				Promise.resolve({
					size: 2048,
					sourceMtimeMs: 1_700_000_000_000,
					audioStreams: [
						{ index: 0, channels: 6, isDefault: true, codec: "aac" },
						{ index: 1, channels: 2, isDefault: false, codec: "ac3" },
					],
				}),
			),
		);

		const revision = await pluginMediaService.getRevision("mf-1");

		expect(revision).toEqual({
			size: 2048,
			sourceMtimeMs: 1_700_000_000_000,
			audioStreams: [
				{ index: 0, channels: 6, isDefault: true },
				{ index: 1, channels: 2, isDefault: false },
			],
		});
	});

	test("returns null when the media file is unknown", async () => {
		activeStubs.push(stubMethod(mediaRepository, "findForPlaybackSession", () => Promise.resolve(undefined)));

		await expect(pluginMediaService.getRevision("missing")).resolves.toBeNull();
	});
});
