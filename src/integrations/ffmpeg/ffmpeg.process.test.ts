import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { killFfmpegProcessGracefully, waitForExitWithTimeout } from "./ffmpeg.process";

/**
 * A process that ignores SIGTERM — the case a plain kill cannot end. It
 * announces that the trap is installed, so the test cannot race the shell's
 * startup and kill it with the default SIGTERM action instead.
 */
async function spawnIgnoringSigterm() {
	const process = spawn({
		cmd: ["sh", "-c", "trap '' TERM; echo ready; while true; do sleep 0.2; done"],
		stdout: "pipe",
		stderr: "ignore",
	});
	const reader = process.stdout.getReader();
	const decoder = new TextDecoder();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (decoder.decode(value, { stream: true }).includes("ready")) break;
	}
	reader.releaseLock();

	return process;
}

describe("killFfmpegProcessGracefully", () => {
	test("ends a process that ignores SIGTERM", async () => {
		const process = await spawnIgnoringSigterm();

		await killFfmpegProcessGracefully(process, 200);

		expect(await waitForExitWithTimeout(process, 5_000)).toBe(true);
	}, 15_000);

	test("ends a process that exits on SIGTERM without escalating", async () => {
		const process = spawn({ cmd: ["sh", "-c", "sleep 30"], stdout: "ignore", stderr: "ignore" });
		await Bun.sleep(200);

		await killFfmpegProcessGracefully(process, 5_000);

		expect(await waitForExitWithTimeout(process, 5_000)).toBe(true);
	}, 15_000);
});
