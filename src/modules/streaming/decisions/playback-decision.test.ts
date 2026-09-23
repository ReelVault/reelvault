import { describe, expect, test } from "bun:test";
import { decidePlaybackMode } from "./playback-decision";

describe("streaming quality decision", () => {
	test("keeps the selected audio stream index in the playback decision", () => {
		expect(decidePlaybackMode({ videoCodec: "h264", audioCodec: "aac" }, { videoCodecs: ["h264"], audioCodecs: ["aac"] }, 3)).toMatchObject(
			{
				mode: "direct-stream",
				audioStreamIndex: 3,
			},
		);
	});

	test("forces video transcoding when a bitrate cap is requested", () => {
		expect(
			decidePlaybackMode({ videoCodec: "h264", audioCodec: "aac" }, { videoCodecs: ["h264"], audioCodecs: ["aac"], maxBitrate: 2500 }),
		).toMatchObject({
			mode: "transcode",
			videoTranscode: true,
			audioTranscode: false,
			videoBitrateKbps: 2500,
		});
	});

	test("still caps a source that exceeds the requested bitrate", () => {
		expect(
			decidePlaybackMode(
				{ videoCodec: "h264", audioCodec: "aac", bitRate: 8_000_000 },
				{ videoCodecs: ["h264"], audioCodecs: ["aac"], maxBitrate: 2500 },
			),
		).toMatchObject({ mode: "transcode", videoTranscode: true, videoBitrateKbps: 2500 });
	});

	test("remuxes when the source bitrate is already below the requested cap", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "h264", audioCodec: "aac", bitRate: 4_000_000 },
			{ videoCodecs: ["h264"], audioCodecs: ["aac"], maxBitrate: 5000 },
		);
		expect(decision.mode).toBe("direct-stream");
		expect(decision.videoBitrateKbps).toBeUndefined();
	});

	test("transcodes 10-bit HEVC (Main10) even when the client reports h265", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "hevc", audioCodec: "aac", videoProfile: "Main 10", videoPixelFormat: "yuv420p10le" },
			{ videoCodecs: ["h265"], audioCodecs: ["aac"] },
		);
		expect(decision).toMatchObject({ mode: "transcode", videoTranscode: true });
		expect(decision.reason).toContain("10-bit");
	});

	test("remuxes Main10 HEVC when the client reports h265-10bit", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "hevc", audioCodec: "aac", videoProfile: "Main 10", videoPixelFormat: "yuv420p10le" },
			{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"] },
		);
		expect(decision.mode).toBe("direct-stream");
		expect(decision.videoTranscode).toBe(false);
	});

	test("remuxes 10-bit AV1 — profile 0 covers 8- and 10-bit", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "av1", audioCodec: "aac", videoPixelFormat: "yuv420p10le" },
			{ videoCodecs: ["av1"], audioCodecs: ["aac"] },
		);
		expect(decision.mode).toBe("direct-stream");
	});

	test("transcodes 10-bit VP9 when the client reports only vp9", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "vp9", audioCodec: "aac", videoPixelFormat: "yuv420p10le" },
			{ videoCodecs: ["vp9"], audioCodecs: ["aac"] },
		);
		expect(decision).toMatchObject({ mode: "transcode", videoTranscode: true });
	});

	test("transcodes 12-bit sources regardless of client reports", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "av1", audioCodec: "aac", videoPixelFormat: "yuv420p12le" },
			{ videoCodecs: ["av1"], audioCodecs: ["aac"] },
		);
		expect(decision).toMatchObject({ mode: "transcode", videoTranscode: true });
		expect(decision.reason).toContain("12-bit");
	});

	test("transcodes H.264 High10 by profile even without pix_fmt data", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "h264", audioCodec: "aac", videoProfile: "High 10" },
			{ videoCodecs: ["h264"], audioCodecs: ["aac"] },
		);
		expect(decision).toMatchObject({ mode: "transcode", videoTranscode: true });
	});

	test("keeps 8-bit HEVC on the remux path", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "hevc", audioCodec: "aac", videoProfile: "Main", videoPixelFormat: "yuv420p" },
			{ videoCodecs: ["h265"], audioCodecs: ["aac"] },
		);
		expect(decision.mode).toBe("direct-stream");
	});

	test("reports only the streams that are actually transcoded", () => {
		expect(decidePlaybackMode({ videoCodec: "hevc", audioCodec: "ac3" }, { videoCodecs: ["h265"], audioCodecs: ["aac"] })).toMatchObject({
			mode: "transcode",
			videoTranscode: false,
			audioTranscode: true,
			reason: "video:h265 copied; audio:ac3 → AAC",
		});
	});

	test("transcodes only audio when audio codec is incompatible", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "h264", audioCodec: "eac3", audioChannels: 6 },
			{ videoCodecs: ["h264"], audioCodecs: ["aac"] },
			1,
		);

		expect(decision).toMatchObject({ mode: "transcode", videoTranscode: false, audioTranscode: true, audioChannels: 6 });
	});

	test("direct-streams compatible file when bitrate is within acceptable bounds", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "h264", audioCodec: "aac", bitRate: 4_000_000 },
			{ videoCodecs: ["h264"], audioCodecs: ["aac"] },
		);
		expect(decision.mode).toBe("direct-stream");
		expect(decision.videoTranscode).toBe(false);
	});

	test("forces transcode with tone-mapping for HDR10 despite h265-10bit capability", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "h265", audioCodec: "aac", videoPixelFormat: "yuv420p10le", videoColorTransfer: "smpte2084" },
			{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"] },
		);
		expect(decision).toMatchObject({
			mode: "transcode",
			videoTranscode: true,
			tonemap: true,
			tonemapTransfer: "smpte2084",
		});
		expect(decision.reason).toContain("HDR10");
		expect(decision.reason).toContain("tone-mapped to SDR");
	});

	test("labels HLG and Dolby Vision sources correctly", () => {
		const hlg = decidePlaybackMode(
			{ videoCodec: "h265", audioCodec: "aac", videoColorTransfer: "arib-std-b67" },
			{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"] },
		);
		expect(hlg).toMatchObject({ videoTranscode: true, tonemap: true });
		expect(hlg.reason).toContain("HLG");

		const dv = decidePlaybackMode(
			{ videoCodec: "h265", audioCodec: "aac", videoPixelFormat: "yuv420p10le", doviProfile: 8 },
			{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"] },
		);
		expect(dv).toMatchObject({ videoTranscode: true, tonemap: true, tonemapTransfer: "smpte2084" });
		expect(dv.reason).toContain("DV8");
	});

	test("keeps 10-bit SDR content on the direct-stream path", () => {
		const decision = decidePlaybackMode(
			{ videoCodec: "h265", audioCodec: "aac", videoPixelFormat: "yuv420p10le" },
			{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"] },
		);
		expect(decision.mode).toBe("direct-stream");
		expect(decision.tonemap).toBeUndefined();
	});
});

test("transcodes HDR10 (tonemap) when the client reports no HDR render path", () => {
	const decision = decidePlaybackMode(
		{ videoCodec: "hevc", audioCodec: "aac", videoPixelFormat: "yuv420p10le", videoColorTransfer: "smpte2084" },
		{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"] },
	);
	expect(decision).toMatchObject({ mode: "transcode", videoTranscode: true, tonemap: true });
	expect(decision.reasons?.video.code).toBe("video.transcode_hdr");
});

test("passthrough HDR10 to a client that probes smpte2084", () => {
	const decision = decidePlaybackMode(
		{ videoCodec: "hevc", audioCodec: "aac", videoPixelFormat: "yuv420p10le", videoColorTransfer: "smpte2084" },
		{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"], hdrTransfers: ["smpte2084"] },
	);
	expect(decision).toMatchObject({ mode: "direct-stream", videoTranscode: false, hdrPassthrough: true });
	expect(decision.tonemap).toBeUndefined();
	expect(decision.reasons?.video.code).toBe("video.copy_hdr");
});

test("passthrough HLG via the hlg probe", () => {
	const decision = decidePlaybackMode(
		{ videoCodec: "hevc", audioCodec: "aac", videoPixelFormat: "yuv420p10le", videoColorTransfer: "arib-std-b67" },
		{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"], hdrTransfers: ["smpte2084", "arib-std-b67"] },
	);
	expect(decision).toMatchObject({ mode: "direct-stream", hdrPassthrough: true });
});

test("keeps transcoding DV profile 5 even when the client reports HDR support", () => {
	const decision = decidePlaybackMode(
		{ videoCodec: "hevc", audioCodec: "aac", videoPixelFormat: "yuv420p10le", doviProfile: 5 },
		{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"], hdrTransfers: ["smpte2084"] },
	);
	expect(decision).toMatchObject({ mode: "transcode", videoTranscode: true, tonemap: true });
});

test("passthrough DV profile 8 via its HDR10 base layer", () => {
	const decision = decidePlaybackMode(
		{ videoCodec: "hevc", audioCodec: "aac", videoPixelFormat: "yuv420p10le", doviProfile: 8 },
		{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"], hdrTransfers: ["smpte2084"] },
	);
	expect(decision).toMatchObject({ mode: "direct-stream", hdrPassthrough: true });
});

test("a bitrate cap defeats HDR passthrough and keeps the tonemap", () => {
	const decision = decidePlaybackMode(
		{ videoCodec: "hevc", audioCodec: "aac", videoPixelFormat: "yuv420p10le", videoColorTransfer: "smpte2084", bitRate: 40_000_000 },
		{ videoCodecs: ["h265", "h265-10bit"], audioCodecs: ["aac"], hdrTransfers: ["smpte2084"], maxBitrate: 2500 },
	);
	expect(decision).toMatchObject({ mode: "transcode", videoTranscode: true, tonemap: true });
});
