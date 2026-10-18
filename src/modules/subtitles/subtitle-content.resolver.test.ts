import { describe, expect, test } from "bun:test";
import { type SubtitleContent, SubtitleContentResolver } from "./subtitle-content.resolver";

const CONTROLLER = new AbortController();

/**
 * The provider's content store and the ffmpeg extraction are the process boundaries. Each fake
 * returns a body that names the path it came from, so the assertions read the routing outcome.
 */
function createResolver(overrides: { externalContent?: SubtitleContent | null; embeddedContent?: SubtitleContent | null } = {}) {
	let capturedSignal: AbortSignal | undefined;
	const resolver = new SubtitleContentResolver({
		getExternalContent: (id) =>
			Promise.resolve(
				overrides.externalContent !== undefined
					? overrides.externalContent
					: { contentType: "text/plain", file: new Blob([`external:${id}`]) },
			),
		extractEmbeddedContent: (id, mediaFilePath, streamIndex, format, signal) => {
			capturedSignal = signal;

			return Promise.resolve(
				overrides.embeddedContent !== undefined
					? overrides.embeddedContent
					: { contentType: "text/vtt", file: new Blob([`embedded:${id}:${mediaFilePath}:${streamIndex}:${format}`]) },
			);
		},
	});

	return { resolver, capturedSignal: () => capturedSignal };
}

describe("SubtitleContentResolver", () => {
	test("resolves external subtitles through the provider content store", async () => {
		const { resolver } = createResolver();

		const content = await resolver.resolve("sub-1", { type: "external", mediaFileId: "file-1", streamIndex: null, format: "srt" });

		expect(content.contentType).toBe("text/plain");
		expect(await content.file.text()).toBe("external:sub-1");
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

	test("throws not found when the provider has no external content", async () => {
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
