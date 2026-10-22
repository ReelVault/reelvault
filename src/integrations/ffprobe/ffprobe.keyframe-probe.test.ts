import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { FFProbeBuilder } from "./ffprobe.builder";
import { findKeyframeBefore, pickLastKeyframePackets } from "./ffprobe.keyframe-probe";
import { ffProbeService } from "./ffprobe.service";

afterEach(() => {
	mock.restore();
});

const packet = (pts: string, flags: string) => ({ pts_time: pts, flags });

/**
 * A stand-in for the ffprobe process, which is the only thing replaced. Like the
 * real binary it answers with the packets inside the `-read_intervals` window.
 */
function probeOf(packets: Array<{ pts_time: string; flags: string }>): FFProbeBuilder {
	return new FFProbeBuilder(({ cmd }) => {
		const [from = 0, to = Number.POSITIVE_INFINITY] = (cmd[cmd.indexOf("-read_intervals") + 1] ?? "").split("%").map(Number);
		const inWindow = packets.filter((entry) => Number(entry.pts_time) >= from && Number(entry.pts_time) <= to);

		return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ packets: inWindow }), stderr: "", timedOut: false });
	});
}

/** Serves a fresh probe for every `create()` call, as the service does: a builder collects the arguments of one probe only. */
function serveProbe(packets: Array<{ pts_time: string; flags: string }>): void {
	spyOn(ffProbeService, "create").mockImplementation(() => probeOf(packets));
}

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
	it("finds the last keyframe at or before the target", async () => {
		serveProbe([packet("98.000000", "K__"), packet("98.042000", "___"), packet("100.000000", "K__")]);

		expect(await findKeyframeBefore("/media/last-keyframe.mkv", 99.5)).toBe(98);
		expect(await findKeyframeBefore("/media/last-keyframe.mkv", 100)).toBe(100);
	});

	it("does not look more than 15 seconds before the target", async () => {
		serveProbe([packet("84.2", "K__")]);

		expect(await findKeyframeBefore("/media/window-outside.mkv", 99.5)).toBeNull();
	});

	it("finds a keyframe inside the 15 second look-back before the target", async () => {
		serveProbe([packet("84.6", "K__")]);

		expect(await findKeyframeBefore("/media/window-inside.mkv", 99.5)).toBe(84.6);
	});

	it("reports no keyframe when the window holds none", async () => {
		serveProbe([packet("98.042000", "___")]);

		expect(await findKeyframeBefore("/media/no-keyframe.mkv", 99.5)).toBeNull();
	});

	it("spawns no probe for a target at the start of the file", async () => {
		const create = spyOn(ffProbeService, "create");

		expect(await findKeyframeBefore("/media/start-of-file.mkv", 0)).toBeNull();
		expect(create).not.toHaveBeenCalled();
	});
});
