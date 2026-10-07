import type { Subprocess } from "bun";
import { serverConfig } from "@/server.config";

/** How long to wait for a SIGKILLed process to reap before giving up on the handle. */
const KILL_EXIT_GRACE_MS = 10_000;

/** Waits for exit with a bound — an uninterruptible process must not wedge release/shutdown. */
export async function waitForExitWithTimeout(process: Subprocess, timeoutMs = KILL_EXIT_GRACE_MS): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const exited = await Promise.race([
		process.exited.then(() => true),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
			timer.unref();
		}),
	]);
	clearTimeout(timer);

	return exited;
}

/** Attempts a graceful FFmpeg shutdown, escalating to SIGKILL after a timeout. */
export async function killFfmpegProcessGracefully(
	process: Subprocess,
	timeoutMs = serverConfig.ffmpeg.gracefulShutdownTimeoutMs,
): Promise<void> {
	if (!process.pid) return;

	process.kill("SIGTERM");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const exitedInTime = await Promise.race([
		process.exited.then(() => true),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
			timer.unref();
		}),
	]);
	clearTimeout(timer);

	if (!exitedInTime) {
		// `process.killed` only means "a signal was sent" (it is true right after
		// SIGTERM), so guarding on it made SIGKILL dead code and left stuck FFmpeg
		// processes behind. The race already tells us the process did not exit.
		try {
			process.kill("SIGKILL");
		} catch {
			// Already exited between the race and here.
		}

		// Bounded wait: an uninterruptible kernel state (e.g. a stalled network
		// mount) would otherwise block session release and shutdown forever.
		await waitForExitWithTimeout(process).catch(() => false);
	}
}
