import { describe, expect, test } from "bun:test";
import { parseSegmentName } from "./segment-name.utils";

describe("segment name utils", () => {
	test("parses segment index and start time", () => {
		expect(parseSegmentName("seg_12.m4s", 4)).toEqual({ index: 12, startTime: 48 });
		expect(parseSegmentName("seg_0.m4s", 6)).toEqual({ index: 0, startTime: 0 });
	});

	test("parses multi-digit and large indexes correctly", () => {
		expect(parseSegmentName("seg_20.m4s", 4)).toEqual({ index: 20, startTime: 80 });
		expect(parseSegmentName("seg_123.m4s", 4)).toEqual({ index: 123, startTime: 492 });
		expect(parseSegmentName("seg_9999.m4s", 2)).toEqual({ index: 9999, startTime: 19998 });
	});

	test("falls back to segment zero for non-segment names", () => {
		expect(parseSegmentName("init.mp4", 4)).toEqual({ index: 0, startTime: 0 });
		expect(parseSegmentName("playlist.m3u8", 4)).toEqual({ index: 0, startTime: 0 });
	});

	test("falls back for empty or malformed strings", () => {
		expect(parseSegmentName("", 4)).toEqual({ index: 0, startTime: 0 });
		expect(parseSegmentName("seg_.m4s", 4)).toEqual({ index: 0, startTime: 0 });
		expect(parseSegmentName("seg_abc.m4s", 4)).toEqual({ index: 0, startTime: 0 });
		expect(parseSegmentName(".m4s", 4)).toEqual({ index: 0, startTime: 0 });
		expect(parseSegmentName("seg_", 4)).toEqual({ index: 0, startTime: 0 });
	});

	test("falls back for wrong prefix or suffix", () => {
		expect(parseSegmentName("segment_12.m4s", 4)).toEqual({ index: 0, startTime: 0 });
		expect(parseSegmentName("seg_12.mp4", 4)).toEqual({ index: 0, startTime: 0 });
		expect(parseSegmentName("SEG_12.M4S", 4)).toEqual({ index: 0, startTime: 0 });
		expect(parseSegmentName("seg_12", 4)).toEqual({ index: 0, startTime: 0 });
	});

	test("rejects negative indexes", () => {
		expect(parseSegmentName("seg_-5.m4s", 4)).toEqual({ index: 0, startTime: 0 });
	});

	test("handles zero duration without breaking startTime math", () => {
		expect(parseSegmentName("seg_5.m4s", 0)).toEqual({ index: 5, startTime: 0 });
	});

	test("handles decimal segment durations", () => {
		expect(parseSegmentName("seg_3.m4s", 1.5)).toEqual({ index: 3, startTime: 4.5 });
	});
});
