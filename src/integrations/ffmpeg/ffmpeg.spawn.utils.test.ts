import { describe, expect, test } from "bun:test";
import { runTracked } from "./ffmpeg.spawn.utils";

describe("runTracked", () => {
	test("runs a short process to completion without reporting a timeout", async () => {
		const tracked = runTracked({
			cmd: [process.execPath, "-e", "process.exit(0)"],
			purpose: "probe",
			timeoutMs: 5_000,
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
		const tracked = runTracked({
			cmd: [process.execPath, "-e", "setTimeout(() => {}, 2_000)"],
			purpose: "probe",
			timeoutMs: 50,
			unreapedMessage: "probe did not exit",
		});

		try {
			await tracked.process.exited;
			expect(tracked.timedOut()).toBeTrue();
			expect(tracked.process.signalCode).toBe("SIGKILL");
		} finally {
			tracked.cleanup();
		}
	});

	test("kills a process when its abort signal fires", async () => {
		const controller = new AbortController();
		const tracked = runTracked({
			cmd: [process.execPath, "-e", "setTimeout(() => {}, 2_000)"],
			purpose: "background",
			signal: controller.signal,
			unreapedMessage: "background did not exit",
		});

		try {
			controller.abort();
			await tracked.process.exited;
			expect(tracked.process.signalCode).toBe("SIGKILL");
			expect(tracked.timedOut()).toBeFalse();
		} finally {
			tracked.cleanup();
		}
	});
});
