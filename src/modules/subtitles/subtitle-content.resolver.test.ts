import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@/utils/directory.utils";
import { readExternalSubtitle, type SubtitleContent, SubtitleContentResolver, subtitleContentResolver } from "./subtitle-content.resolver";

const CONTROLLER = new AbortController();

/**
 * The stored external file and the ffmpeg extraction are the process boundaries. Each fake
 * returns a body that names the path it came from, so the assertions read the routing outcome.
 */
function createResolver(overrides: { externalContent?: SubtitleContent | null; embeddedContent?: SubtitleContent | null } = {}) {
	let capturedSignal: AbortSignal | undefined;
	const resolver = new SubtitleContentResolver({
		readExternalContent: (info) =>
			Promise.resolve(
				overrides.externalContent === undefined
					? { contentType: "text/plain", file: new Blob([`external:${info.filePath}`]) }
					: overrides.externalContent,
			),
		extractEmbeddedContent: (id, mediaFilePath, streamIndex, format, signal) => {
			capturedSignal = signal;

			return Promise.resolve(
				overrides.embeddedContent === undefined
					? { contentType: "text/vtt", file: new Blob([`embedded:${id}:${mediaFilePath}:${streamIndex}:${format}`]) }
					: overrides.embeddedContent,
			);
		},
	});

	return { resolver, capturedSignal: () => capturedSignal };
}

describe("SubtitleContentResolver", () => {
	test("resolves external subtitles from their stored file", async () => {
		const { resolver } = createResolver();

		const content = await resolver.resolve("sub-1", {
			type: "external",
			mediaFileId: "file-1",
			streamIndex: null,
			format: "srt",
			filePath: "/media/movie.pl.srt",
		});

		expect(content.contentType).toBe("text/plain");
		expect(await content.file.text()).toBe("external:/media/movie.pl.srt");
	});

	test("resolves embedded subtitles through the extractor with the cached info and the request signal", async () => {
		const { resolver, capturedSignal } = createResolver();

		const content = await resolver.resolve(
			"sub-2",
			{ type: "embedded", mediaFileId: "file-1", streamIndex: 3, format: "subrip", mediaFilePath: "/media/movie.mkv" },
			CONTROLLER.signal,
		);

		expect(content.contentType).toBe("text/vtt");
		expect(await content.file.text()).toBe("embedded:sub-2:/media/movie.mkv:3:subrip");
		expect(capturedSignal()).toBe(CONTROLLER.signal);
	});

	test("throws not found when the external file cannot be served", async () => {
		const { resolver } = createResolver({ externalContent: null });

		await expect(
			resolver.resolve("sub-3", { type: "external", mediaFileId: "file-1", streamIndex: null, format: "srt" }),
		).rejects.toMatchObject({
			category: "not_found",
			code: "entity.not_found",
			params: { entityType: "Subtitle content", entityId: "sub-3" },
		});
	});

	test("throws not found when extraction of an embedded track fails", async () => {
		const { resolver } = createResolver({ embeddedContent: null });

		await expect(
			resolver.resolve("sub-4", {
				type: "embedded",
				mediaFileId: "file-1",
				streamIndex: 3,
				format: "subrip",
				mediaFilePath: "/media/a.mkv",
			}),
		).rejects.toMatchObject({ category: "not_found", code: "entity.not_found" });
	});

	test("throws not found for an embedded subtitle without a media file path", async () => {
		const { resolver } = createResolver();

		await expect(
			resolver.resolve("sub-5", { type: "embedded", mediaFileId: "file-1", streamIndex: 3, format: "subrip" }),
		).rejects.toMatchObject({
			category: "not_found",
			code: "subtitle.not_found",
		});
	});

	test("throws not found for an unknown subtitle type instead of falling back to a provider", async () => {
		const { resolver } = createResolver();

		await expect(
			resolver.resolve("sub-6", { type: "weird", mediaFileId: "file-1", streamIndex: null, format: "srt" }),
		).rejects.toMatchObject({
			category: "not_found",
			code: "subtitle.not_found",
		});
	});
});

describe("subtitle extractability", () => {
	test("asking for an image-based track names its code instead of reporting it missing", async () => {
		await expect(
			subtitleContentResolver.resolve("sub-1", {
				type: "embedded",
				mediaFileId: "file-1",
				streamIndex: 2,
				format: "hdmv_pgs_subtitle",
				mediaFilePath: "/media/file.mkv",
			}),
		).rejects.toMatchObject({ code: "subtitle.bitmap_unsupported" });
	});
});

describe("external subtitle files", () => {
	let workDir = "";
	let subtitlesRoot = "";
	let movieFolder = "";

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "reelvault-subtitle-content-"));
		subtitlesRoot = join(workDir, "subtitles");
		movieFolder = join(workDir, "library", "Example Movie (2024)");
		await mkdir(subtitlesRoot, { recursive: true });
		await mkdir(movieFolder, { recursive: true });
	});

	afterEach(async () => {
		await removeTree(workDir);
	});

	test("serves an uploaded WebVTT file from the subtitles root", async () => {
		const filePath = join(subtitlesRoot, "upload.vtt");
		await Bun.write(filePath, "WEBVTT\n");

		const content = await readExternalSubtitle(
			{
				type: "external",
				mediaFileId: "file-1",
				streamIndex: null,
				format: "vtt",
				filePath,
				mediaFilePath: join(movieFolder, "movie.mkv"),
			},
			subtitlesRoot,
		);

		expect(content?.contentType).toBe("text/vtt");
		expect(await content?.file.text()).toBe("WEBVTT\n");
	});

	test("serves a sidecar SRT the scanner imported from the folder of its video", async () => {
		const filePath = join(movieFolder, "movie.pl.srt");
		await Bun.write(filePath, "1\n00:00:01,000 --> 00:00:02,000\nCześć\n");

		const content = await readExternalSubtitle(
			{
				type: "external",
				mediaFileId: "file-1",
				streamIndex: null,
				format: "srt",
				filePath,
				mediaFilePath: join(movieFolder, "movie.mkv"),
			},
			subtitlesRoot,
		);

		expect(content?.contentType).toBe("text/plain; charset=utf-8");
		expect(await content?.file.text()).toBe("1\n00:00:01,000 --> 00:00:02,000\nCześć\n");
	});

	test("refuses a stored path outside the subtitles root and the folder of its video", async () => {
		// The file exists, so only the folder check can refuse it.
		const filePath = join(workDir, "elsewhere.srt");
		await Bun.write(filePath, "1\n");

		const content = await readExternalSubtitle(
			{
				type: "external",
				mediaFileId: "file-1",
				streamIndex: null,
				format: "srt",
				filePath,
				mediaFilePath: join(movieFolder, "movie.mkv"),
			},
			subtitlesRoot,
		);

		expect(content).toBeNull();
	});

	test("reports a sidecar deleted from disk as missing", async () => {
		const content = await readExternalSubtitle(
			{
				type: "external",
				mediaFileId: "file-1",
				streamIndex: null,
				format: "srt",
				filePath: join(movieFolder, "gone.srt"),
				mediaFilePath: join(movieFolder, "movie.mkv"),
			},
			subtitlesRoot,
		);

		expect(content).toBeNull();
	});
});
