import { type Subprocess, spawn } from "bun";
import { watchForUnreapedProcess } from "./ffmpeg.process";
import { type FfmpegProcessPurpose, ffmpegProcessTracker } from "./ffmpeg.process-tracker";

export interface RunTrackedOptions {
	cmd: string[];
	purpose: FfmpegProcessPurpose;
	stdout?: "pipe" | "ignore" | undefined;
	/** Bun's per-stream buffer cap for collected output. */
	maxBuffer?: number | undefined;
	/** Hard wall-clock limit; `onTimeout` decides how the process is stopped. */
	timeoutMs?: number | undefined;
	/** Defaults to SIGKILL. */
	onTimeout?: ((process: Subprocess, boundReap: () => void) => void) | undefined;
	/** Aborting kills the process with SIGKILL. */
	signal?: AbortSignal | undefined;
	/** Owner tag and stderr provider for the admin process list and failure diagnostics. */
	label?: string | undefined;
	stderrTail?: (() => string) | undefined;
	/** Exit callback for long-lived processes that are not awaited. */
	onExit?:
		| ((subprocess: Subprocess, exitCode: number | null, signalCode: NodeJS.Signals | number | null, error?: Bun.ErrorLike) => void)
		| undefined;
	/** Message for the unreaped-process timeout. */
	unreapedMessage: string;
}

export interface TrackedProcess {
	/** stderr is always piped: every caller reads or monitors it. */
	process: Subprocess<"ignore" | "pipe", "ignore" | "pipe", "pipe">;
	/** Rejects when the process never reaps after a kill; race collectors against it. */
	unreaped: Promise<never>;
	timedOut: () => boolean;
	cleanup: () => void;
}

function killOnTimeout(process: Subprocess, boundReap: () => void): void {
	process.kill("SIGKILL");
	boundReap();
}

/**
 * The one ffmpeg/ffprobe spawn path. Registers the process with the admin
 * tracker, arms the optional hard timeout and abort, bounds the SIGKILL wait
 * and releases the listeners on cleanup. Output collection stays with the caller.
 */
export function runTracked({
	cmd,
	purpose,
	stdout = "pipe",
	maxBuffer,
	timeoutMs,
	onTimeout = killOnTimeout,
	signal,
	label,
	stderrTail,
	onExit,
	unreapedMessage,
}: RunTrackedOptions): TrackedProcess {
	const process = spawn({
		cmd,
		stdout,
		stderr: "pipe",
		...(maxBuffer === undefined ? {} : { maxBuffer }),
		...(onExit === undefined ? {} : { onExit }),
	});
	ffmpegProcessTracker.track(process, purpose, stderrTail, label);
	const { unreaped, boundReap } = watchForUnreapedProcess(process, unreapedMessage);

	const state = { timedOut: false };
	let timer: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs !== undefined) {
		timer = setTimeout(() => {
			state.timedOut = true;
			onTimeout(process, boundReap);
		}, timeoutMs);
		timer.unref();
	}

	const abort = () => {
		try {
			process.kill("SIGKILL");
		} catch {
			// Already exited.
		}
		boundReap();
	};
	signal?.addEventListener("abort", abort, { once: true });

	let cleaned = false;
	return {
		process,
		unreaped,
		timedOut: () => state.timedOut,
		cleanup: () => {
			if (cleaned) return;
			cleaned = true;

			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		},
	};
}
