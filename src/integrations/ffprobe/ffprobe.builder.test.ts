import { describe, expect, test } from "bun:test";
import { FFProbeBuilder } from "./ffprobe.builder";

/** A probe process that answers with a fixed stdout. */
function probeAnswering(stdout: string) {
	return async () => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
}

describe("FFProbeBuilder", () => {
	test("reads a format probe", async () => {
		const builder = new FFProbeBuilder(
			probeAnswering(JSON.stringify({ format: { duration: "12.5" }, streams: [{ codec_type: "video" }] })),
		);

		const result = await builder.execute("/media/format.mkv");

		expect(result.format.duration).toBe("12.5");
		expect(result.streams).toHaveLength(1);
	});

	test("reads a packet listing, which carries no streams or format", async () => {
		// A packet listing is the shape ffprobe answers `-show_entries
		// packet=…` with. The format probe's shape check rejects it, so the
		// keyframe probe never got a result and every seek fell back to the
		// requested offset.
		const builder = new FFProbeBuilder(
			probeAnswering(
				JSON.stringify({
					packets: [
						{ pts_time: "12.000000", flags: "K__" },
						{ pts_time: "12.042000", flags: "___" },
					],
				}),
			),
		);

		const packets = await builder.executePackets("/media/packets.mkv");

		expect(packets).toEqual([
			{ pts_time: "12.000000", flags: "K__" },
			{ pts_time: "12.042000", flags: "___" },
		]);
	});

	test("keeps a packet listing and a format probe apart", async () => {
		// The same arguments can be read either way; the cached result must not
		// be handed to the other reader.
		const builder = new FFProbeBuilder(
			probeAnswering(JSON.stringify({ format: { duration: "12.5" }, streams: [], packets: [{ pts_time: "1.000000", flags: "K__" }] })),
		);

		const result = await builder.execute("/media/both.mkv");
		const packets = await builder.executePackets("/media/both.mkv");

		expect(result.format.duration).toBe("12.5");
		expect(packets).toEqual([{ pts_time: "1.000000", flags: "K__" }]);
	});

	test("refuses a packet listing that is not packet-shaped", async () => {
		const builder = new FFProbeBuilder(probeAnswering(JSON.stringify({ packets: [{ pts_time: 12 }] })));

		await expect(builder.executePackets("/media/bad-packets.mkv")).rejects.toMatchObject({
			category: "internal",
			code: "ffprobe_invalid_output",
		});
	});

	test("refuses a format probe that is not format-shaped", async () => {
		const builder = new FFProbeBuilder(probeAnswering(JSON.stringify({ packets: [] })));

		await expect(builder.execute("/media/bad-format.mkv")).rejects.toMatchObject({
			category: "internal",
			code: "ffprobe_invalid_output",
		});
	});
});
