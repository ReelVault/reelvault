import { describe, expect, test } from "bun:test";
import type { CreatePlaybackSession } from "@reelvault/sdk/common";
import { assertSafeId, parseCapabilities, toPlaybackSessionInput } from "./session-request.mapper";

describe("session request mapper", () => {
	test("assertSafeId accepts safe ids and rejects path-like input", () => {
		expect(() => assertSafeId("abc_123-XYZ")).not.toThrow();
		expect(() => assertSafeId("session-1", "sessionId")).not.toThrow();
		expect(() => assertSafeId("../etc/passwd")).toThrow("Invalid fileId");
		expect(() => assertSafeId("bad id")).toThrow("Invalid fileId");
		expect(() => assertSafeId("")).toThrow("Invalid fileId");
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
		expect(capabilities.videoCodecs.length).toBeGreaterThan(0);
		expect(capabilities.audioCodecs.length).toBeGreaterThan(0);
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
