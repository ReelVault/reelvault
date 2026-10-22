import { describe, expect, test } from "bun:test";
import { ffMpegService } from "./ffmpeg.service";

describe("FFmpeg integration", () => {
	test("runs the installed ffmpeg binary and reports its version", async () => {
		const result = await ffMpegService.runToCompletion(["-version"]);
		const banner = new TextDecoder().decode(result.stdout);

		expect(result.exitCode).toBe(0);
		// The banner line is the contract; the build may print extra lines around it.
		expect(banner.split("\n").some((line) => line.startsWith("ffmpeg version"))).toBeTrue();
	});
});
