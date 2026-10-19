import { describe, expect, it, spyOn } from "bun:test";
import { FFProbeBuilder } from "./ffprobe.builder";
import { findKeyframeBefore, pickLastKeyframePackets } from "./ffprobe.keyframe-probe";
import { ffProbeService } from "./ffprobe.service";

const packet = (pts: string, flags: string) => ({ pts_time: pts, flags });

describe("pickLastKeyframePackets", () => {
	it("returns the last keyframe at or before the limit", () => {
		const packets = [packet("10.5", "K__"), packet("10.54", "__"), packet("12.1", "K__"), packet("12.14", "__"), packet("14.9", "K__")];
		expect(pickLastKeyframePackets(packets, 15)).toBe(14.9);
	});

	it("ignores keyframes beyond the limit (float tolerance)", () => {
		const packets = [packet("10.5", "K__"), packet("15.01", "K__")];
		expect(pickLastKeyframePackets(packets, 15)).toBe(10.5);
	});

	it("ignores packets without a keyframe flag or unparsable pts", () => {
		const packets = [packet("N/A", "K__"), packet("3.2", "K_"), packet("4.0", "__")];
		expect(pickLastKeyframePackets(packets, 10)).toBe(3.2);
	});

	it("returns null when no keyframe is found", () => {
		expect(pickLastKeyframePackets([packet("5", "__")], 10)).toBeNull();
		expect(pickLastKeyframePackets([], 10)).toBeNull();
	});
});

describe("findKeyframeBefore", () => {
	it("finds the keyframe at or before the target", async () => {
		const builder = new FFProbeBuilder(async () => ({
			exitCode: 0,
			stdout: JSON.stringify({ packets: [packet("98.000000", "K__"), packet("98.042000", "___"), packet("100.000000", "K__")] }),
			stderr: "",
			timedOut: false,
		}));
		const probe = spyOn(ffProbeService, "create").mockReturnValue(builder);

		expect(await findKeyframeBefore("/media/movie.mkv", 99.5)).toBe(98);
		expect(await findKeyframeBefore("/media/movie.mkv", 100)).toBe(100);

		probe.mockRestore();
	});

	it("reports no keyframe when the window holds none", async () => {
		const builder = new FFProbeBuilder(async () => ({
			exitCode: 0,
			stdout: JSON.stringify({ packets: [packet("98.042000", "___")] }),
			stderr: "",
			timedOut: false,
		}));
		const probe = spyOn(ffProbeService, "create").mockReturnValue(builder);

		expect(await findKeyframeBefore("/media/no-keyframe.mkv", 99.5)).toBeNull();

		probe.mockRestore();
	});
});
