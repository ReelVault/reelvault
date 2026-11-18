import { describe, expect, test } from "bun:test";
import { AUDIO_CODEC_MAP, normalizeCodec, VIDEO_CODEC_MAP } from "./codec-maps.constants";

describe("codec normalization", () => {
	test.each([
		{ label: "the canonical video tag", input: "vp9", expected: "vp9" },
		{ label: "a video alias", input: "vp09", expected: "vp9" },
		{ label: "the canonical MPEG-4 tag", input: "mpeg4", expected: "mpeg4" },
		{ label: "an MPEG-4 alias", input: "xvid", expected: "mpeg4" },
	] as const)("$label normalizes to $expected", ({ input, expected }) => {
		expect(normalizeCodec(input, VIDEO_CODEC_MAP)).toBe(expected);
	});

	test.each([
		{ label: "the canonical audio tag", input: "aac", expected: "aac" },
		{ label: "TrueHD", input: "truehd", expected: "truehd" },
		{ label: "a 16-bit PCM tag", input: "pcm_s16le", expected: "pcm" },
		{ label: "a 24-bit PCM tag", input: "pcm_s24le", expected: "pcm" },
	] as const)("$label normalizes to $expected", ({ input, expected }) => {
		expect(normalizeCodec(input, AUDIO_CODEC_MAP)).toBe(expected);
	});
});
