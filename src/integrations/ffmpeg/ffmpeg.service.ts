import { spawn, which } from "bun";
import { FFmpegBuilder } from "@/integrations/ffmpeg/ffmpeg.builder";
import { assertFFMpegAvailable } from "@/integrations/ffmpeg/ffmpeg.environment";
import { serverConfig } from "@/server.config";
import { RequestTimeoutError } from "@/utils/errors";
import { detach } from "@/utils/promise.utils";
import { killFfmpegProcessGracefully } from "./ffmpeg.process";
import { type FfmpegProcessPurpose, ffmpegProcessTracker } from "./ffmpeg.process-tracker";

export interface FfmpegRunOptions {
	signal?: AbortSignal | undefined;
	stdout?: "pipe" | "ignore" | undefined;
	/** Hard wall-clock limit. On expiry the process is killed gracefully (SIGTERM → SIGKILL) and the call throws. */
	timeoutMs?: number | undefined;
	/** Maximum number of stdout bytes to accept. The process is killed once the limit is exceeded. */
	maxOutputBytes?: number | undefined;
	/**
	 * Maximum number of stderr bytes retained. ffmpeg writes progress and stats
	 * for the whole decode (e.g. loudnorm streams a line per frame), so stderr is
	 * capped by keeping the LAST maxStderrBytes — errors and JSON reports are
	 * always at the end of the stream.
	 */
	maxStderrBytes?: number | undefined;
	/** Defaults to "background": the server rescue system may kill it under pressure. */
	purpose?: FfmpegProcessPurpose | undefined;
}

/** Default retention for stderr (4 MiB tail). */
const DEFAULT_MAX_STDERR_BYTES = 4 * 1024 * 1024;

interface FfmpegExecutionResult {
	exitCode: number | null;
	stdout: Uint8Array;
	stderr: string;
}

class FFmpegService {
	isAvailable(): boolean {
		return Boolean(which(serverConfig.ffmpeg.path));
	}

	killAll(): void {
		ffmpegProcessTracker.killAll();
	}

	create() {
		assertFFMpegAvailable();

		return new FFmpegBuilder();
	}

	async runToCompletion(args: string[], optionsOrSignal?: AbortSignal | FfmpegRunOptions): Promise<FfmpegExecutionResult> {
		assertFFMpegAvailable();
		const options: FfmpegRunOptions = optionsOrSignal instanceof AbortSignal ? { signal: optionsOrSignal } : (optionsOrSignal ?? {});
		const signal = options.signal;
		const stdoutMode = options.stdout ?? "pipe";
		const { timeoutMs, maxOutputBytes } = options;
		const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

		if (signal?.aborted) throw signal.reason ?? new Error("FFmpeg execution was cancelled");

		const process = spawn({ cmd: [serverConfig.ffmpeg.path, ...args], stdout: stdoutMode, stderr: "pipe" });
		if (stdoutMode === "pipe" && !process.stdout) {
			process.kill("SIGKILL");
			throw new Error("FFmpeg execution could not start");
		}

		ffmpegProcessTracker.track(process, options.purpose ?? "background");

		const abort = () => {
			try {
				process.kill("SIGKILL");
			} catch {
				// Ignore kill error
			}
		};
		signal?.addEventListener("abort", abort, { once: true });

		const timeoutState = { timedOut: false };
		const timeoutTimer =
			timeoutMs !== undefined
				? setTimeout(() => {
						timeoutState.timedOut = true;
						detach(
							(async () => {
								try {
									await killFfmpegProcessGracefully(process);
								} catch {
									// Graceful-kill failures are non-fatal; the timeout already fired.
								}
							})(),
						);
					}, timeoutMs)
				: undefined;
		timeoutTimer?.unref();

		try {
			const stdoutPromise =
				stdoutMode === "pipe" && process.stdout
					? collectStdout(process.stdout, maxOutputBytes, () => {
							process.kill("SIGKILL");
						})
					: Promise.resolve(new Uint8Array(0));
			const [exitCode, stdout, stderr] = await Promise.all([
				process.exited,
				stdoutPromise,
				collectStderrTail(process.stderr, maxStderrBytes),
			]);
			if (signal?.aborted) throw signal.reason ?? new Error("FFmpeg execution was cancelled");

			if (timeoutState.timedOut && timeoutMs !== undefined) {
				throw new RequestTimeoutError(`FFmpeg execution timed out after ${timeoutMs}ms`);
			}

			return { exitCode, stdout, stderr };
		} finally {
			if (timeoutTimer) clearTimeout(timeoutTimer);

			signal?.removeEventListener("abort", abort);
		}
	}
}

/**
 * Consumes the whole stderr stream but retains only the last `maxBytes` bytes.
 * ffmpeg emits per-frame progress/stats for the entire decode, so buffering the
 * full stream would grow with file length (a 4-hour loudnorm analysis streams
 * tens of MB); the useful output — errors and JSON reports — is always at the end.
 */
async function collectStderrTail(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let retainedBytes = 0;
	const decoder = new TextDecoder();

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			chunks.push(value);
			retainedBytes += value.byteLength;
			while (retainedBytes > maxBytes && chunks.length > 1) {
				const dropped = chunks[0];
				if (dropped === undefined) break;

				chunks.shift();
				retainedBytes -= dropped.byteLength;
			}
		}
	} finally {
		reader.releaseLock();
	}

	const parts: string[] = [];
	for (const chunk of chunks) parts.push(decoder.decode(chunk, { stream: true }));

	parts.push(decoder.decode());

	return parts.join("");
}

/**
 * Reads stdout chunk by chunk so the output size is capped even when FFmpeg
 * misbehaves. Bytes are only buffered while the total stays within the limit;
 * past it the process is killed and the whole call fails.
 */
async function collectStdout(
	stream: ReadableStream<Uint8Array>,
	maxOutputBytes: number | undefined,
	kill: () => void,
): Promise<Uint8Array> {
	if (maxOutputBytes === undefined) return new Uint8Array(await new Response(stream).arrayBuffer());

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			totalBytes += value.byteLength;
			if (totalBytes > maxOutputBytes) {
				kill();
				throw new Error(`FFmpeg stdout exceeded the maximum output size of ${maxOutputBytes} bytes`);
			}

			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return output;
}

export const ffMpegService = new FFmpegService();
