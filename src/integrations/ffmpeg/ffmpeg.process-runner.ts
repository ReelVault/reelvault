import { DomainError } from "@/utils/domain.errors";
import type { FfmpegProcessPurpose } from "./ffmpeg.process-tracker";
import { spawnTracked } from "./ffmpeg.spawn.utils";

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
	const tracked = spawnTracked({
		cmd,
		purpose,
		maxBuffer,
		timeoutMs,
		// A process stuck in an uninterruptible state never reaps after SIGKILL;
		// bound the wait instead of holding the caller's semaphore slot forever.
		onTimeout: (process, boundReap) => {
			process.kill("SIGKILL");
			boundReap();
		},
		unreapedMessage: "Process did not exit after SIGKILL",
	});

	const stdoutStream = tracked.process.stdout;
	const stderrStream = tracked.process.stderr;
	if (typeof stdoutStream === "number" || typeof stderrStream === "number") {
		tracked.cleanup();
		throw new DomainError("internal", "FFmpeg output is not piped", { code: "ffmpeg.start_failed" });
	}

	try {
		const [exitCode, stdout, stderr] = await Promise.race([
			Promise.all([tracked.process.exited, new Response(stdoutStream).text(), new Response(stderrStream).text()]),
			tracked.unreaped,
		]);

		return { exitCode, stdout, stderr, timedOut: tracked.timedOut() };
	} finally {
		tracked.cleanup();
	}
}
