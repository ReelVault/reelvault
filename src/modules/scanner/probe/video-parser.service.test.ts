import { describe, expect, test } from "bun:test";
import { videoParser } from "./video-parser.service";

describe("videoParser", () => {
	test("returns null (never throws) for a file that cannot be probed", async () => {
		// Works regardless of whether ffprobe itself is installed: a missing
		// binary and a missing file both fail the probe and degrade to null.
		const result = await videoParser.probe(`/nonexistent/reelvault-${crypto.randomUUID()}.mkv`);

		expect(result).toBeNull();
	});
});
