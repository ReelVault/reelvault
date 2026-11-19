import { describe, expect, test } from "bun:test";
import { CancellationError } from "@/utils/cancellation.utils";
import { ffMpegService } from "./ffmpeg.service";

// `-re` reads the synthetic source in real time, so a 600 s source keeps the
// process running long enough for the limits below to fire first.
const LONG_REALTIME_SOURCE = ["-re", "-f", "lavfi", "-i", "testsrc=d=600", "-f", "null", "-"];
const SMALL_RAW_VIDEO = ["-f", "lavfi", "-i", "testsrc=d=1:s=64x64:r=25", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];

describe("FFmpeg integration", () => {
	test("runs the installed ffmpeg binary and reports its version", async () => {
		const result = await ffMpegService.runToCompletion(["-version"]);
		const banner = new TextDecoder().decode(result.stdout);

		expect(result.exitCode).toBe(0);
		// The banner line is the contract; the build may print extra lines around it.
		expect(banner.split("\n").some((line) => line.startsWith("ffmpeg version"))).toBeTrue();
	});

	test("stops a run that outlives its timeout and reports the timeout", async () => {
		await expect(ffMpegService.runToCompletion(LONG_REALTIME_SOURCE, { timeoutMs: 300 })).rejects.toMatchObject({
			category: "timeout",
			code: "ffmpeg.timeout",
		});
	}, 15_000);

	test("kills a running encode when its abort signal fires", async () => {
		const controller = new AbortController();
		const reason = new CancellationError("encode cancelled by the caller");
		const run = ffMpegService.runToCompletion(LONG_REALTIME_SOURCE, { signal: controller.signal });
		controller.abort(reason);

		await expect(run).rejects.toBe(reason);
	}, 15_000);

	test("kills an encode that writes more stdout than maxOutputBytes allows", async () => {
		await expect(ffMpegService.runToCompletion(SMALL_RAW_VIDEO, { maxOutputBytes: 1_000 })).rejects.toMatchObject({
			category: "internal",
			code: "ffmpeg.output_limit_exceeded",
		});
	}, 15_000);
});
