import { describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { spawnTracked } from "./ffmpeg.spawn.utils";

const killOnTimeout = (process: Subprocess, boundReap: () => void) => {
	process.kill("SIGKILL");
	boundReap();
};

describe("spawnTracked", () => {
	test("runs a short process to completion without reporting a timeout", async () => {
		const tracked = spawnTracked({
			cmd: ["sh", "-c", "exit 0"],
			purpose: "probe",
			timeoutMs: 5_000,
			onTimeout: killOnTimeout,
			unreapedMessage: "probe did not exit",
		});

		try {
			expect(await tracked.process.exited).toBe(0);
			expect(tracked.timedOut()).toBeFalse();
		} finally {
			tracked.cleanup();
		}
	});

	test("kills a process whose timeout fires and reports the timeout", async () => {
		const tracked = spawnTracked({
			cmd: ["sleep", "5"],
			purpose: "probe",
			timeoutMs: 50,
			onTimeout: killOnTimeout,
			unreapedMessage: "probe did not exit",
		});

		try {
			await tracked.process.exited;
			expect(tracked.timedOut()).toBeTrue();
		} finally {
			tracked.cleanup();
		}
	});

	test("calls the spawn and cleanup hooks once, even when cleanup runs twice", async () => {
		let spawned = false;
		let cleaned = 0;
		const tracked = spawnTracked({
			cmd: ["sh", "-c", "exit 0"],
			purpose: "diagnostic",
			onTimeout: killOnTimeout,
			onSpawn: () => {
				spawned = true;
			},
			onCleanup: () => {
				cleaned++;
			},
			unreapedMessage: "probe did not exit",
		});

		await tracked.process.exited;
		expect(spawned).toBeTrue();

		tracked.cleanup();
		tracked.cleanup();
		expect(cleaned).toBe(1);
	});
});
