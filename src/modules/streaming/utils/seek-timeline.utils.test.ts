import { describe, expect, test } from "bun:test";
import { resolveSeekTimelineStart } from "./seek-timeline.utils";

describe("seek timeline utils", () => {
	test("transcode restarts exactly at the requested offset", async () => {
		const probeCalls: Array<[string, number]> = [];
		const timelineStart = await resolveSeekTimelineStart("transcode", "/media/f.mkv", 120, (path, offset) => {
			probeCalls.push([path, offset]);

			return 100;
		});

		expect(timelineStart).toBe(120);
		expect(probeCalls).toEqual([]);
	});

	test("direct-stream aligns to the nearest keyframe before the offset", async () => {
		const timelineStart = await resolveSeekTimelineStart("direct-stream", "/media/f.mkv", 120, async () => 118.5);

		expect(timelineStart).toBe(118.5);
	});

	test("direct-stream falls back to the offset when no keyframe probe is available", async () => {
		const timelineStart = await resolveSeekTimelineStart("direct-stream", "/media/f.mkv", 120, async () => null);

		expect(timelineStart).toBe(120);
	});
});
