import { describe, expect, test } from "bun:test";
import { NotFoundError } from "@/utils/errors";
import { type SubtitleContent, SubtitleContentResolver } from "./subtitle-content.resolver";

interface Overrides {
	externalContent?: SubtitleContent | null;
	embeddedContent?: SubtitleContent | null;
}

function createResolver(overrides: Overrides = {}) {
	const calls = { external: 0, embedded: 0 };
	let capturedSignal: AbortSignal | undefined;
	const resolver = new SubtitleContentResolver({
		getExternalContent: (id) => {
			calls.external++;

			return Promise.resolve(
				overrides.externalContent !== undefined ? overrides.externalContent : { contentType: "text/plain", file: new Blob([id]) },
			);
		},
		extractEmbeddedContent: (id, mediaFilePath, streamIndex, format, signal) => {
			calls.embedded++;
			capturedSignal = signal;

			return Promise.resolve(
				overrides.embeddedContent !== undefined
					? overrides.embeddedContent
					: { contentType: "text/vtt", file: new Blob([`${id}:${mediaFilePath}:${streamIndex}:${format}`]) },
			);
		},
	});

	return { resolver, calls, capturedSignal: () => capturedSignal };
}

const CONTROLLER = new AbortController();

describe("SubtitleContentResolver", () => {
	test("resolves external subtitles through the provider content store", async () => {
		const { resolver, calls } = createResolver();

		const content = await resolver.resolve("sub-1", { type: "external", mediaFileId: "file-1", streamIndex: null, format: "srt" });

		expect(content.file).toBeInstanceOf(Blob);
		expect(calls.external).toBe(1);
		expect(calls.embedded).toBe(0);
	});

	test("resolves embedded subtitles through the extractor with the cached info and signal", async () => {
		const { resolver, calls, capturedSignal } = createResolver();

		const content = await resolver.resolve(
			"sub-2",
			{ type: "embedded", mediaFileId: "file-1", streamIndex: 3, format: "subrip", mediaFilePath: "/media/movie.mkv" },
			CONTROLLER.signal,
		);

		expect(content.contentType).toBe("text/vtt");
		expect(calls.embedded).toBe(1);
		expect(calls.external).toBe(0);
		expect(capturedSignal()).toBe(CONTROLLER.signal);
	});

	test("throws not found when the provider has no external content", () => {
		const { resolver } = createResolver({ externalContent: null });

		expect(resolver.resolve("sub-3", { type: "external", mediaFileId: "file-1", streamIndex: null, format: "srt" })).rejects.toThrow(
			"Subtitle content not found: sub-3",
		);
	});

	test("throws not found when extraction of an embedded track fails", () => {
		const { resolver } = createResolver({ embeddedContent: null });

		expect(
			resolver.resolve("sub-4", {
				type: "embedded",
				mediaFileId: "file-1",
				streamIndex: 3,
				format: "subrip",
				mediaFilePath: "/media/a.mkv",
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("throws not found for an embedded subtitle without a media file path", () => {
		const { resolver, calls } = createResolver();

		expect(resolver.resolve("sub-5", { type: "embedded", mediaFileId: "file-1", streamIndex: 3, format: "subrip" })).rejects.toThrow(
			"Subtitle content for sub-5 was not found",
		);
		expect(calls.embedded).toBe(0);
	});

	test("throws not found for an unknown subtitle type", () => {
		const { resolver, calls } = createResolver();

		expect(resolver.resolve("sub-6", { type: "weird", mediaFileId: "file-1", streamIndex: null, format: "srt" })).rejects.toBeInstanceOf(
			NotFoundError,
		);
		expect(calls.external).toBe(0);
		expect(calls.embedded).toBe(0);
	});
});
