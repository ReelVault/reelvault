import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { getBufferedSeekStart, isPositionBuffered, parseHlsBuffer } from "@/modules/streaming/buffer/hls-buffer.utils";

beforeEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

afterEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

describe("HLS buffering", () => {
	it("reports completed segments and preserves gaps between buffered ranges", () => {
		const analysis = parseHlsBuffer(
			["#EXTM3U", "#EXTINF:6.000,", "seg_0.m4s", "#EXTINF:6.000,", "seg_1.m4s", "#EXTINF:5.000,", "seg_3.m4s", "#EXT-X-ENDLIST"].join("\n"),
			6,
		);

		expect(analysis.complete).toBeTrue();
		expect(analysis.bufferedSeconds).toBe(17);
		expect(analysis.bufferedUntil).toBe(23);
		expect(analysis.ranges).toEqual([
			{ startTime: 0, endTime: 12, startSegment: 0, endSegment: 1, segmentCount: 2 },
			{ startTime: 18, endTime: 23, startSegment: 3, endSegment: 3, segmentCount: 1 },
		]);
		expect(isPositionBuffered(analysis, 10)).toBeTrue();
		expect(isPositionBuffered(analysis, 15)).toBeFalse();
		expect(getBufferedSeekStart(analysis, 10, 6)).toBe(6);
		expect(getBufferedSeekStart(analysis, 15, 6)).toBeNull();
	});
});
