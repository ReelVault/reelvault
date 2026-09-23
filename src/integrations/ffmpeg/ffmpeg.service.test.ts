import { describe, expect, test } from "bun:test";
import { ffMpegService } from "./ffmpeg.service";

// Integration boundary — requires the real binary. Skipped where absent
// (CI images, fresh machines); argument-building logic is covered by
// ffmpeg.transcode-args.test.ts and ffmpeg.capabilities.test.ts.
const hasFfmpeg = ffMpegService.isAvailable();

describe("FFmpeg integration", () => {
	test.skipIf(!hasFfmpeg)("executes FFmpeg arguments through the integration boundary", async () => {
		const result = await ffMpegService.runToCompletion(["-version"]);

		expect(result.exitCode).toBe(0);
		expect(new TextDecoder().decode(result.stdout)).toStartWith("ffmpeg version");
	});
});
