import { describe, expect, test } from "bun:test";
import { ffMpegService } from "./ffmpeg.service";

describe("FFmpeg integration", () => {
	test("runs the installed ffmpeg binary and reports its version", async () => {
		const result = await ffMpegService.runToCompletion(["-version"]);

		expect(result.exitCode).toBe(0);
		expect(new TextDecoder().decode(result.stdout)).toStartWith("ffmpeg version");
	});
});
