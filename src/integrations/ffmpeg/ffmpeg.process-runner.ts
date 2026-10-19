import { spawn } from "bun";
import { watchForUnreapedProcess } from "./ffmpeg.process";
import { type FfmpegProcessPurpose, ffmpegProcessTracker } from "./ffmpeg.process-tracker";

export interface SpawnCollectResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface SpawnCollectOptions {
	cmd: string[];
	timeoutMs?: number | undefined;
	purpose: FfmpegProcessPurpose;
	maxBuffer?: number | undefined;
}

/**
 * Spawns a short-lived ffmpeg/ffprobe process, tracks it, enforces a hard
 * timeout (SIGKILL) and collects the full stdout/stderr as text. Streaming
 * runs with output caps or graceful kills use the dedicated FFmpeg runner.
 */
export async function spawnAndCollect({ cmd, timeoutMs, purpose, maxBuffer }: SpawnCollectOptions): Promise<SpawnCollectResult> {
	const subprocess = spawn({
		cmd,
		stdout: "pipe",
		stderr: "pipe",
		...(maxBuffer !== undefined ? { maxBuffer } : {}),
	});
	ffmpegProcessTracker.track(subprocess, purpose);

	const state = { timedOut: false };
	// A process stuck in an uninterruptible state never reaps after SIGKILL;
	// bound the wait instead of holding the caller's semaphore slot forever.
	const { unreaped, boundReap } = watchForUnreapedProcess(subprocess, "Process did not exit after SIGKILL");
	const timer =
		timeoutMs !== undefined
			? setTimeout(() => {
					state.timedOut = true;
					subprocess.kill("SIGKILL");
					boundReap();
				}, timeoutMs)
			: undefined;
	timer?.unref();

	try {
		const [exitCode, stdout, stderr] = await Promise.race([
			Promise.all([subprocess.exited, new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text()]),
			unreaped,
		]);

		return { exitCode, stdout, stderr, timedOut: state.timedOut };
	} finally {
		if (timer) clearTimeout(timer);
	}
}
