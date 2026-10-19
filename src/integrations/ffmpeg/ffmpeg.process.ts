import type { Subprocess } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { DomainError } from "@/utils/domain.errors";
import { detach } from "@/utils/promise.utils";

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
	const exitedInTime = await waitForExitWithTimeout(process, timeoutMs);

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

export interface UnreapedProcessWatch {
	/** Rejects when the process never reaped, so the wait on it is bounded. */
	unreaped: Promise<never>;
	/** Arms the watch: call it once the process was killed. */
	boundReap: () => void;
}

/**
 * Watches a killed process for an exit that never comes.
 *
 * A process stuck in an uninterruptible state (a stalled network mount) never
 * reaps after SIGKILL, so a wait on it has to be bounded — otherwise the caller
 * holds its semaphore slot (or its worker) forever.
 */
export function watchForUnreapedProcess(process: Subprocess, message: string): UnreapedProcessWatch {
	let rejectUnreaped: ((error: DomainError) => void) | undefined;
	const unreaped = new Promise<never>((_resolve, reject) => {
		rejectUnreaped = reject;
	});

	const boundReap = () => {
		detach(
			(async () => {
				try {
					if (await waitForExitWithTimeout(process)) return;
				} catch {
					// A failed exit read counts as unreaped.
				}

				rejectUnreaped?.(new DomainError("timeout", message, { code: "ffmpeg.kill_timeout" }));
			})(),
		);
	};

	return { unreaped, boundReap };
}
