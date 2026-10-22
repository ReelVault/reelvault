import { describe, expect, test } from "bun:test";
import { resolveSeekTimelineStart } from "./seek-timeline.utils";

describe("seek timeline utils", () => {
	test("transcode restarts exactly at the requested offset", async () => {
		// The probe reports a keyframe at 100; a transcode restart must ignore it and start at the offset.
		const timelineStart = await resolveSeekTimelineStart("transcode", "/media/f.mkv", 120, async () => 100);

		expect(timelineStart).toBe(120);
	});

	test("direct-stream restarts at the keyframe the probe finds before the offset", async () => {
		const timelineStart = await resolveSeekTimelineStart("direct-stream", "/media/f.mkv", 120, async () => 118.5);

		expect(timelineStart).toBe(118.5);
	});

	test("direct-stream falls back to the offset when no keyframe probe is available", async () => {
		const timelineStart = await resolveSeekTimelineStart("direct-stream", "/media/f.mkv", 120, async () => null);

		expect(timelineStart).toBe(120);
	});
});
