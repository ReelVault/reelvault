import { describe, expect, test } from "bun:test";
import { type CreatePlaybackSession, DEFAULT_BROWSER_CAPABILITIES } from "@reelvault/sdk/common";
import { assertSafeId, parseCapabilities, toPlaybackSessionInput } from "./session-request.mapper";

describe("session request mapper", () => {
	test("assertSafeId rejects path-like, spaced and empty ids as invalid", () => {
		expect(() => assertSafeId("../etc/passwd")).toThrow(expect.objectContaining({ category: "validation", code: "stream.id_invalid" }));
		expect(() => assertSafeId("bad id")).toThrow(expect.objectContaining({ category: "validation", code: "stream.id_invalid" }));
		expect(() => assertSafeId("")).toThrow(expect.objectContaining({ category: "validation", code: "stream.id_invalid" }));
	});

	test("parseCapabilities splits, deduplicates and sorts codec lists", () => {
		expect(parseCapabilities({ videoCodecs: "H264, hevc, h264", audioCodecs: " aac " })).toEqual({
			videoCodecs: ["h264", "hevc"],
			audioCodecs: ["aac"],
			hdrTransfers: [],
			maxBitrate: undefined,
		});
	});

	test("parseCapabilities falls back to browser defaults for empty lists", () => {
		const capabilities = parseCapabilities({});
		expect(capabilities.videoCodecs).toEqual(DEFAULT_BROWSER_CAPABILITIES.videoCodecs);
		expect(capabilities.audioCodecs).toEqual(DEFAULT_BROWSER_CAPABILITIES.audioCodecs);
		expect(parseCapabilities({ videoCodecs: "", maxBitrate: 8000 }).maxBitrate).toBe(8000);
	});

	test("toPlaybackSessionInput joins codec arrays and drops nulls", () => {
		const request: CreatePlaybackSession = {
			mediaFileId: "file-1",
			videoCodecs: ["h264", "hevc"],
			audioCodecs: ["aac"],
			maxBitrate: null,
			audioStreamIndex: null,
			audioLanguage: null,
			subtitleLanguage: "pl",
			subtitlesEnabled: true,
			forcedSubtitlesOnly: null,
		};
		expect(toPlaybackSessionInput(request)).toEqual({
			videoCodecs: "h264,hevc",
			audioCodecs: "aac",
			maxBitrate: undefined,
			audioStreamIndex: undefined,
			audioLanguage: undefined,
			subtitleLanguage: "pl",
			subtitlesEnabled: true,
			forcedSubtitlesOnly: undefined,
		});
	});

	test("parseCapabilities filters hdrTransfers to the known allowlist", () => {
		const capabilities = parseCapabilities({ hdrTransfers: "SMPTE2084, junk, arib-std-b67, smpte2084" });
		expect(capabilities.hdrTransfers).toEqual(["arib-std-b67", "smpte2084"]);
		expect(parseCapabilities({ hdrTransfers: "hlg-junk" }).hdrTransfers).toEqual([]);
	});

	test("toPlaybackSessionInput joins hdrTransfers as a comma list", () => {
		const request: CreatePlaybackSession = {
			mediaFileId: "file-1",
			videoCodecs: ["h265"],
			hdrTransfers: ["smpte2084"],
		};
		expect(toPlaybackSessionInput(request).hdrTransfers).toBe("smpte2084");
		expect(toPlaybackSessionInput({ mediaFileId: "file-1", hdrTransfers: null }).hdrTransfers).toBeUndefined();
	});
});
