import type { Subprocess } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { MIB } from "@/utils/bytes.utils";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { DomainError } from "@/utils/domain.errors";
import { detach } from "@/utils/promise.utils";
import { FFmpegBuilder } from "./ffmpeg.builder";
import { assertFFMpegAvailable } from "./ffmpeg.environment";
import { killFfmpegProcessGracefully } from "./ffmpeg.process";
import { type FfmpegProcessPurpose, ffmpegProcessTracker } from "./ffmpeg.process-tracker";
import { runTracked } from "./ffmpeg.spawn.utils";

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
const DEFAULT_MAX_STDERR_BYTES = 4 * MIB;

interface FfmpegExecutionResult {
	exitCode: number | null;
	stdout: Uint8Array;
	stderr: string;
	/** Peak resident set size of the child, when the runtime reports it. */
	maxRssBytes?: number | undefined;
}

/** Diagnostic-only peak RSS; a missing or failing runtime API must never fail a completed run. */
function readMaxRssBytes(process: Subprocess): number | undefined {
	try {
		return process.resourceUsage()?.maxRSS;
	} catch {
		return undefined;
	}
}

export const ffMpegService = {
	isAvailable(): boolean {
		try {
			assertFFMpegAvailable();

			return true;
		} catch {
			return false;
		}
	},

	killAll(): void {
		ffmpegProcessTracker.killAll();
	},

	create() {
		assertFFMpegAvailable();

		return new FFmpegBuilder();
	},

	async runToCompletion(args: string[], optionsOrSignal?: AbortSignal | FfmpegRunOptions): Promise<FfmpegExecutionResult> {
		assertFFMpegAvailable();
		const options: FfmpegRunOptions = optionsOrSignal instanceof AbortSignal ? { signal: optionsOrSignal } : (optionsOrSignal ?? {});
		const signal = options.signal;
		const stdoutMode = options.stdout ?? "pipe";
		const { timeoutMs, maxOutputBytes } = options;
		const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

		throwIfAborted(signal);

		const tracked = runTracked({
			cmd: [serverConfig.ffmpeg.path, ...args],
			purpose: options.purpose ?? "background",
			stdout: stdoutMode,
			timeoutMs,
			signal,
			onTimeout: (process, boundReap) => {
				detach(
					(async () => {
						try {
							await killFfmpegProcessGracefully(process);
						} catch {
							// Graceful-kill failures are non-fatal; the timeout already fired.
						}
					})(),
				);
				boundReap();
			},
			unreapedMessage: "FFmpeg did not exit after SIGKILL",
		});

		const process = tracked.process;
		const stdoutStream = process.stdout;
		const stderrStream = process.stderr;
		if (stdoutMode === "pipe" && (!stdoutStream || typeof stdoutStream === "number")) {
			process.kill("SIGKILL");
			tracked.cleanup();
			throw new DomainError("internal", "FFmpeg execution could not start", { code: "ffmpeg.start_failed" });
		}

		try {
			let stdoutPromise: Promise<Uint8Array>;
			if (stdoutMode === "pipe" && stdoutStream && typeof stdoutStream !== "number") {
				stdoutPromise = collectStdout(stdoutStream, maxOutputBytes, () => {
					process.kill("SIGKILL");
				});
			} else {
				stdoutPromise = Promise.resolve(new Uint8Array(0));
			}
			const [exitCode, stdout, stderr] = await Promise.race([
				Promise.all([process.exited, stdoutPromise, collectStderrTail(stderrStream, maxStderrBytes)]),
				tracked.unreaped,
			]);
			throwIfAborted(signal);

			if (tracked.timedOut() && timeoutMs !== undefined) {
				throw new DomainError("timeout", `FFmpeg execution timed out after ${timeoutMs}ms`, { code: "ffmpeg.timeout" });
			}

			const maxRssBytes = readMaxRssBytes(process);

			return {
				exitCode,
				stdout,
				stderr,
				...(maxRssBytes === undefined ? {} : { maxRssBytes }),
			};
		} finally {
			tracked.cleanup();
		}
	},
};

/** Reads a stream to its end, handing each chunk to `onChunk` as it arrives. */
async function readChunks(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void): Promise<void> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			onChunk(value);
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Consumes the whole stderr stream but retains only the last `maxBytes` bytes.
 * ffmpeg emits per-frame progress/stats for the entire decode, so buffering the
 * full stream would grow with file length (a 4-hour loudnorm analysis streams
 * tens of MB); the useful output — errors and JSON reports — is always at the end.
 */
async function collectStderrTail(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
	const chunks: Uint8Array[] = [];
	let retainedBytes = 0;
	const decoder = new TextDecoder();

	await readChunks(stream, (value) => {
		chunks.push(value);
		retainedBytes += value.byteLength;
		while (retainedBytes > maxBytes && chunks.length > 1) {
			const dropped = chunks.shift();
			if (dropped === undefined) break;

			retainedBytes -= dropped.byteLength;
		}
	});

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

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	await readChunks(stream, (value) => {
		totalBytes += value.byteLength;
		if (totalBytes > maxOutputBytes) {
			kill();
			throw new DomainError("internal", `FFmpeg stdout exceeded the maximum output size of ${maxOutputBytes} bytes`, {
				code: "ffmpeg.output_limit_exceeded",
			});
		}

		chunks.push(value);
	});

	const output = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return output;
}
