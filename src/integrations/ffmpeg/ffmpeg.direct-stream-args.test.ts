import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import { systemResourcesService } from "@/config/system-resources.service";
import { buildDirectStreamOutputArgs } from "./ffmpeg.direct-stream-args";

const config: TranscodeConfig = {
	maxSessions: 1,
	inactivityTimeout: 30_000,
	cleanupInterval: 10_000,
	tempRootDir: "/tmp/reelvault-test-transcodes",
	hlsSegmentDuration: 6,
};

const decision: PlaybackDecision = {
	mode: "direct-stream",
	videoTranscode: false,
	audioTranscode: false,
	audioStreamIndex: 2,
	reason: "Compatible streams",
};

const spies: Array<{ mockRestore(): void }> = [];

/** Pins the thread budget so the assertion does not depend on the host's CPU count. */
function budget(value: number): void {
	spies.push(spyOn(systemResourcesService, "getFfmpegThreads").mockReturnValue(value));
}

/** The value that follows a flag: the builder pairs each option with its value. */
function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);

	return index === -1 ? undefined : args[index + 1];
}

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("buildDirectStreamOutputArgs", () => {
	test("copies both streams and strips the source metadata", () => {
		budget(4);

		const args = buildDirectStreamOutputArgs(decision, config, 1, "/tmp/seg_%d.m4s");

		expect(valueAfter(args, "-codec:v:0")).toBe("copy");
		expect(valueAfter(args, "-codec:a:0")).toBe("copy");
		expect(valueAfter(args, "-map_metadata")).toBe("-1");
		expect(valueAfter(args, "-map_chapters")).toBe("-1");
	});

	test("maps the video and the chosen audio stream and drops the subtitles", () => {
		budget(4);

		const args = buildDirectStreamOutputArgs(decision, config, 1, "/tmp/seg_%d.m4s");

		expect(args).toEqual(expect.arrayContaining(["-map", "0:v:0", "-map", "0:2?", "-map", "-0:s"]));
	});

	test("tags an HEVC stream as hvc1 and leaves an H.264 stream untagged", () => {
		budget(4);

		const hevc = buildDirectStreamOutputArgs({ ...decision, videoCodec: "hevc" }, config, 0, "/tmp/seg_%d.m4s");
		const avc = buildDirectStreamOutputArgs({ ...decision, videoCodec: "h264" }, config, 0, "/tmp/seg_%d.m4s");

		expect(hevc).toEqual(expect.arrayContaining(["-tag:v:0", "hvc1"]));
		expect(avc).not.toContain("-tag:v:0");
	});

	test("keeps the whole thread budget for a remux", () => {
		budget(4);

		const args = buildDirectStreamOutputArgs(decision, config, 1, "/tmp/seg_%d.m4s");
		const threadIndex = args.indexOf("-threads");

		expect(args.slice(threadIndex, threadIndex + 2)).toEqual(["-threads", "4"]);
	});

	test("starts the segment numbering at the requested segment", () => {
		budget(4);

		const args = buildDirectStreamOutputArgs(decision, config, 7, "/tmp/seg_%d.m4s");

		expect(args).toEqual(expect.arrayContaining(["-start_number", "7"]));
		expect(args).toEqual(expect.arrayContaining(["-hls_segment_filename", "/tmp/seg_%d.m4s"]));
	});

	// A stream that starts mid-playback has to carry the discontinuity flag so
	// the player does not treat the first segment as a continuation.
	test("adds the discontinuity flag only when the stream starts mid-playback", () => {
		budget(4);

		const resumed = buildDirectStreamOutputArgs(decision, config, 7, "/tmp/seg_%d.m4s");
		const fresh = buildDirectStreamOutputArgs(decision, config, 0, "/tmp/seg_%d.m4s");

		expect(resumed).toEqual(expect.arrayContaining(["-hls_flags", "independent_segments+temp_file+discont_start"]));
		expect(resumed).toEqual(expect.arrayContaining(["-hls_segment_options", "movflags=+frag_discont"]));
		expect(fresh).toEqual(expect.arrayContaining(["-hls_flags", "independent_segments+temp_file"]));
		expect(fresh).not.toContain("-hls_segment_options");
	});
});
