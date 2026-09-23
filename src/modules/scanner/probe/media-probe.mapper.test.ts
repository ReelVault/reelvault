import { describe, expect, test } from "bun:test";
import type { FFProbeResult } from "@/integrations/ffprobe/ffprobe.types";
import { mapMediaFileData, mapMediaProbe } from "./media-probe.mapper";

describe("mapMediaProbe", () => {
	test("maps stream tags, dispositions, and technical data", () => {
		const probe: FFProbeResult = {
			format: { format_name: "matroska", duration: "120.5", size: "12345", bit_rate: "8000000" },
			streams: [
				{
					codec_type: "video",
					index: 0,
					codec_name: "hevc",
					codec_long_name: "H.265 / HEVC",
					profile: "Main 10",
					width: 3840,
					height: 2160,
					pix_fmt: "yuv420p10le",
					color_transfer: "smpte2084",
					color_primaries: "bt2020",
					color_space: "bt2020nc",
					side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 8, dv_level: 6 }],
					avg_frame_rate: "24000/1001",
					bit_rate: "7000000",
					disposition: { default: 1, forced: 0 },
					tags: { language: "eng", title: "Main video" },
				},
				{
					codec_type: "audio",
					index: 1,
					codec_name: "eac3",
					codec_long_name: "ATSC A/52B (AC-3, E-AC-3)",
					channels: 6,
					channel_layout: "5.1(side)",
					sample_rate: "48000",
					bit_rate: "768000",
					disposition: { default: 0, forced: 1, comment: 1 },
					tags: { language: "pol", title: "Lektor" },
				},
				{
					codec_type: "subtitle",
					index: 2,
					codec_name: "subrip",
					codec_long_name: "SubRip subtitle",
					disposition: { default: 1, forced: 0, hearing_impaired: 1 },
					tags: { language: "pol", title: "Polski" },
				},
			],
		};

		expect(mapMediaProbe(probe)).toEqual({
			formatName: "matroska",
			duration: 120,
			size: 12345,
			bitRate: 8000000,
			videoStreams: [
				{
					index: 0,
					codecName: "hevc",
					codecLongName: "H.265 / HEVC",
					profile: "Main 10",
					width: 3840,
					height: 2160,
					pixelFormat: "yuv420p10le",
					colorTransfer: "smpte2084",
					colorPrimaries: "bt2020",
					colorSpace: "bt2020nc",
					doviProfile: 8,
					frameRate: "24000/1001",
					bitRate: 7000000,
					language: "eng",
					title: "Main video",
					isDefault: true,
					isForced: false,
				},
			],
			audioStreams: [
				{
					index: 1,
					codecName: "eac3",
					codecLongName: "ATSC A/52B (AC-3, E-AC-3)",
					channels: 6,
					channelLayout: "5.1(side)",
					sampleRate: 48000,
					bitRate: 768000,
					language: "pol",
					title: "Lektor",
					isDefault: false,
					isForced: true,
					isCommentary: true,
				},
			],
			subtitles: [
				{
					language: "pol",
					label: "Polski",
					format: "subrip",
					streamIndex: 2,
					isDefault: true,
					isForced: false,
					isHearingImpaired: true,
				},
			],
		});
	});

	test("preserves audio streams when ffprobe omits their channel layout", () => {
		const probe: FFProbeResult = {
			format: { format_name: "matroska", duration: "120", size: "12345", bit_rate: "8000000" },
			streams: [
				{
					codec_type: "audio",
					index: 1,
					codec_name: "ac3",
					codec_long_name: "ATSC A/52A (AC-3)",
					channels: 2,
					sample_rate: "44100",
					disposition: { default: 1, forced: 0 },
					tags: { language: "pol", title: "Lektor" },
				},
			],
		};

		expect(mapMediaProbe(probe).audioStreams).toEqual([
			{
				index: 1,
				codecName: "ac3",
				codecLongName: "ATSC A/52A (AC-3)",
				channels: 2,
				channelLayout: null,
				sampleRate: 44100,
				bitRate: null,
				language: "pol",
				title: "Lektor",
				isDefault: true,
				isForced: false,
				isCommentary: false,
			},
		]);
	});

	test("drops embedded cover art video streams that would violate DB constraints", () => {
		const probe: FFProbeResult = {
			format: { format_name: "matroska", duration: "120", size: "12345", bit_rate: "8000000" },
			streams: [
				{
					codec_type: "video",
					index: 0,
					codec_name: "h264",
					codec_long_name: "H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10",
					profile: "High",
					width: 1920,
					height: 1080,
					pix_fmt: "yuv420p",
					avg_frame_rate: "24/1",
					disposition: { default: 1, forced: 0 },
					tags: {},
				},
				{
					codec_type: "video",
					index: 5,
					codec_name: "mjpeg",
					codec_long_name: "Motion JPEG",
					profile: "Baseline",
					width: 0,
					height: 0,
					disposition: { default: 0, forced: 0, attached_pic: 1 },
					tags: {},
				},
			],
		};

		expect(mapMediaProbe(probe).videoStreams).toEqual([
			{
				index: 0,
				codecName: "h264",
				codecLongName: "H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10",
				profile: "High",
				width: 1920,
				height: 1080,
				pixelFormat: "yuv420p",
				colorTransfer: null,
				colorPrimaries: null,
				colorSpace: null,
				doviProfile: null,
				frameRate: "24/1",
				bitRate: null,
				language: null,
				title: null,
				isDefault: true,
				isForced: false,
			},
		]);
	});

	test("drops attached pictures even when they report dimensions", () => {
		const probe: FFProbeResult = {
			format: { format_name: "matroska", duration: "120", size: "12345", bit_rate: "8000000" },
			streams: [
				{
					codec_type: "video",
					index: 2,
					codec_name: "mjpeg",
					codec_long_name: "Motion JPEG",
					width: 600,
					height: 600,
					disposition: { default: 0, forced: 0, attached_pic: 1 },
					tags: {},
				},
			],
		};

		expect(mapMediaProbe(probe).videoStreams).toEqual([]);
	});
});

describe("mapMediaFileData", () => {
	test("combines ffprobe technical data with filename-derived media tags", () => {
		const probe: FFProbeResult = {
			format: { format_name: "matroska", duration: "120", size: "100", bit_rate: "1000" },
			streams: [
				{
					codec_type: "video",
					index: 0,
					codec_name: "hevc",
					width: 3840,
					height: 2160,
					disposition: { default: 1, forced: 0 },
				},
			],
		};

		expect(mapMediaFileData("Movie.Extended.Remastered.Blu-Ray.mkv", probe)).toMatchObject({
			source: "BluRay",
			edition: "Extended, Remastered",
			qualityTag: "2160p",
		});
	});
});
