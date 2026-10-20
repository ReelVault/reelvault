import { type Subprocess, spawn } from "bun";
import { watchForUnreapedProcess } from "./ffmpeg.process";
import { type FfmpegProcessPurpose, ffmpegProcessTracker } from "./ffmpeg.process-tracker";

export interface SpawnTrackedOptions {
	cmd: string[];
	purpose: FfmpegProcessPurpose;
	stdout?: "pipe" | "ignore" | undefined;
	stderr?: "pipe" | "ignore" | undefined;
	/** Bun's per-stream buffer cap for collected output. */
	maxBuffer?: number | undefined;
	timeoutMs?: number | undefined;
	/** How to stop the process when the timeout fires; `boundReap` bounds the SIGKILL wait. */
	onTimeout: (process: Subprocess, boundReap: () => void) => void;
	/** Extra listener wiring after the process and tracker exist. */
	onSpawn?: ((process: Subprocess, boundReap: () => void) => void) | undefined;
	/** Listener removal on cleanup (abort handlers, collectors). */
	onCleanup?: (() => void) | undefined;
	/** Message for the unreaped-process timeout. */
	unreapedMessage: string;
}

export interface TrackedFfmpegProcess {
	process: Subprocess;
	unreaped: Promise<never>;
	timedOut: () => boolean;
	cleanup: () => void;
}

/**
 * Spawns an ffmpeg/ffprobe process, registers it with the admin tracker, bounds
 * the SIGKILL wait and arms the optional hard timeout. Collectors stay with the
 * caller; this owns the process lifecycle shared by the short-lived probe
 * runner and the streaming runner.
 */
export function spawnTracked({
	cmd,
	purpose,
	stdout = "pipe",
	stderr = "pipe",
	maxBuffer,
	timeoutMs,
	onTimeout,
	onSpawn,
	onCleanup,
	unreapedMessage,
}: SpawnTrackedOptions): TrackedFfmpegProcess {
	const process = spawn({ cmd, stdout, stderr, ...(maxBuffer === undefined ? {} : { maxBuffer }) });
	ffmpegProcessTracker.track(process, purpose);

	const state = { timedOut: false };
	const { unreaped, boundReap } = watchForUnreapedProcess(process, unreapedMessage);

	let timer: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs !== undefined) {
		timer = setTimeout(() => {
			state.timedOut = true;
			onTimeout(process, boundReap);
		}, timeoutMs);
		timer.unref();
	}

	onSpawn?.(process, boundReap);

	let cleaned = false;
	return {
		process,
		unreaped,
		timedOut: () => state.timedOut,
		cleanup: () => {
			if (cleaned) return;
			cleaned = true;

			if (timer) clearTimeout(timer);
			onCleanup?.();
		},
	};
}
