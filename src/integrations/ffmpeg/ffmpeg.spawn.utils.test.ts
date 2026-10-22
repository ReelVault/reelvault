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
			cmd: [process.execPath, "-e", "process.exit(0)"],
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
			cmd: [process.execPath, "-e", "setTimeout(() => {}, 2_000)"],
			purpose: "probe",
			timeoutMs: 50,
			onTimeout: killOnTimeout,
			unreapedMessage: "probe did not exit",
		});

		try {
			await tracked.process.exited;
			expect(tracked.timedOut()).toBeTrue();
			// The process ended by a signal; left alone, its sleep would have run to exit code 0.
			expect(tracked.process.signalCode).not.toBeNull();
		} finally {
			tracked.cleanup();
		}
	});

	test("calls the spawn and cleanup hooks once, even when cleanup runs twice", async () => {
		let spawned = 0;
		let cleaned = 0;
		const tracked = spawnTracked({
			cmd: [process.execPath, "-e", "process.exit(0)"],
			purpose: "diagnostic",
			onTimeout: killOnTimeout,
			onSpawn: () => {
				spawned++;
			},
			onCleanup: () => {
				cleaned++;
			},
			unreapedMessage: "probe did not exit",
		});

		await tracked.process.exited;
		expect(spawned).toBe(1);

		tracked.cleanup();
		tracked.cleanup();
		expect(cleaned).toBe(1);
	});
});
