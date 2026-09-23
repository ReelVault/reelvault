import { type Subprocess, spawn } from "bun";
import { serverConfig } from "@/server.config";
import { createLogger } from "@/utils/logger";
import { detach } from "@/utils/promise.utils";
import { FfmpegOperationLog, type FfmpegOperationLogOptions } from "./ffmpeg.operation-log";
import { type FfmpegProcessPurpose, ffmpegProcessTracker } from "./ffmpeg.process-tracker";

const logger = createLogger("FFmpegBuilder");
const LINE_SEPARATOR_PATTERN = /\r\n|\r|\n/;
/** Last stderr lines kept per process for failure diagnostics (see tracker.getStderrTail). */
const STDERR_TAIL_LINES = 40;

export interface FFmpegProgress {
	frame: number;
	fps: number;
	time: string;
	speed: string;
}

export class FFmpegBuilder {
	private readonly globalArgs: string[] = ["-hide_banner", "-loglevel", "info"];
	private readonly _inputArgs: string[] = [];
	private inputPath?: string | undefined;
	private readonly _outputArgs: string[] = [];
	private operationLogOptions?: Omit<FfmpegOperationLogOptions, "outputPath" | "command"> | undefined;
	private operationLog?: FfmpegOperationLog | undefined;
	private monitorFinished = false;
	private exitInfo?: { exitCode: number | null; signalCode: number | null; error?: Bun.ErrorLike | undefined } | undefined;
	/** Rolling stderr tail — read after a crash to explain why the process died. */
	private readonly stderrTail: string[] = [];
	private _onProgress?: ((progress: FFmpegProgress) => void) | undefined;
	private _onError?: ((error: string) => void) | undefined;
	private _purpose: FfmpegProcessPurpose = "background";
	private _label: string | undefined = undefined;
	private _onExit?: (
		subprocess: Subprocess<"ignore", "ignore", "pipe">,
		exitCode: number | null,
		signalCode: number | null,
		error?: Bun.ErrorLike,
	) => void;

	inputArgs(args: string[]) {
		this._inputArgs.push(...args);

		return this;
	}

	input(path: string) {
		this.inputPath = path;

		return this;
	}

	outputArgs(args: string[]) {
		this._outputArgs.push(...args);

		return this;
	}

	onProgress(cb: (p: FFmpegProgress) => void) {
		this._onProgress = cb;

		return this;
	}

	onError(cb: (e: string) => void) {
		this._onError = cb;

		return this;
	}

	onExit(
		cb: (
			subprocess: Subprocess<"ignore", "ignore", "pipe">,
			exitCode: number | null,
			signalCode: number | null,
			error?: Bun.ErrorLike,
		) => void,
	) {
		this._onExit = cb;

		return this;
	}

	withOperationLog(options: Omit<FfmpegOperationLogOptions, "outputPath" | "command">) {
		this.operationLogOptions = options;

		return this;
	}

	/**
	 * Process purpose for the rescue system. Defaults to `"background"`
	 * (rescue-killable); playback strategies MUST opt into `"streaming"`.
	 */
	purpose(purpose: FfmpegProcessPurpose) {
		this._purpose = purpose;

		return this;
	}

	/** Free-form owner tag surfaced in the admin process list (e.g. session id). */
	label(label: string) {
		this._label = label;

		return this;
	}

	run(outputPath: string): Subprocess {
		const command = [
			serverConfig.ffmpeg.path,
			...this.globalArgs,
			...this._inputArgs,
			...(this.inputPath ? ["-i", this.inputPath] : []),
			...this._outputArgs,
			outputPath,
		];
		if (this.operationLogOptions) {
			try {
				this.operationLog = new FfmpegOperationLog({ ...this.operationLogOptions, outputPath, command });
				logger.debug("FFmpeg operation log created", {
					operationId: this.operationLogOptions.operationId,
					logPath: this.operationLog.filePath,
				});
			} catch (error) {
				logger.warn("Could not create FFmpeg operation log", { error });
			}
		}

		try {
			const process = spawn({
				cmd: command,
				// Nothing ever reads this child's stdout (output goes to outputPath), so
				// an unconsumed pipe here would silently deadlock the session once ffmpeg
				// filled the 64 KB pipe buffer.
				stdout: "ignore",
				stderr: "pipe",
				onExit: (subprocess, exitCode, signalCode, error) => {
					this.exitInfo = { exitCode, signalCode, error };
					try {
						this._onExit?.(subprocess, exitCode, signalCode, error);
					} finally {
						this.finishOperationLog();
					}
				},
			});
			ffmpegProcessTracker.track(process, this._purpose, () => this.stderrTail.join("\n"), this._label);
			this.operationLog?.writeProcessId(process.pid);

			// `stderr: "pipe"` guarantees the stream exists; monitoring finalizes the log.
			detach(this.monitorSilently(process.stderr));

			return process;
		} catch (error) {
			const log = this.operationLog;
			if (log) detach(this.finishLogSilently(log, null, null, error));

			throw error;
		}
	}

	private async attachMonitor(stderr: ReadableStream<Uint8Array>) {
		const reader = stderr.getReader();
		// {stream: true} keeps multi-byte UTF-8 sequences that span chunk boundaries intact.
		const decoder = new TextDecoder();
		// ffmpeg emits progress and log lines on \n or \r; chunks can split a line in
		// half, which previously both mangled characters and hid progress/error matches.
		let pendingLine = "";

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				// The operation log mirrors ffmpeg's raw stderr stream, chunk for chunk.
				this.operationLog?.writeStderr(chunk);
				const lines = (pendingLine + chunk).split(LINE_SEPARATOR_PATTERN);
				pendingLine = lines.pop() ?? "";

				for (const line of lines) {
					this.pushStderrTail(line);
					this.inspectLine(line);
				}
			}

			decoder.decode(); // flush any truncated multi-byte sequence
			if (pendingLine.length > 0) {
				this.pushStderrTail(pendingLine);
				this.inspectLine(pendingLine);
			}
		} catch {
			// Ignore stream errors
		} finally {
			this.monitorFinished = true;
			this.finishOperationLog();
		}
	}

	private pushStderrTail(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		this.stderrTail.push(trimmed);
		if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
	}

	private inspectLine(line: string): void {
		const lower = line.toLowerCase();
		if (lower.includes("error") || lower.includes("fatal")) {
			this._onError?.(line.trim());
		}

		const progress = this.parseProgress(line);
		if (progress) {
			this.operationLog?.writeProgress(line);
			this._onProgress?.(progress);
		}
	}

	private finishOperationLog(): void {
		if (!(this.operationLog && this.monitorFinished && this.exitInfo)) return;

		const { exitCode, signalCode, error } = this.exitInfo;
		detach(this.finishLogSilently(this.operationLog, exitCode, signalCode, error));
	}

	/** Monitor wrapper that can never reject: monitoring is best-effort. */
	private async monitorSilently(stderr: ReadableStream<Uint8Array>): Promise<void> {
		try {
			await this.attachMonitor(stderr);
		} catch {
			// FFmpeg runs fine without progress monitoring.
		}
	}

	/** Operation-log wrapper that can never reject: log finishing is best-effort. */
	private async finishLogSilently(
		log: FfmpegOperationLog,
		exitCode: number | null,
		signalCode: number | null,
		error: unknown,
	): Promise<void> {
		try {
			await log.finish(exitCode, signalCode, error);
		} catch {
			// Log finishing must never affect the ffmpeg run itself.
		}
	}

	private static readonly PROGRESS_PATTERN = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?time=\s*([\d:.]+).*?speed=\s*([\d.]+x)/;

	private parseProgress(text: string): FFmpegProgress | null {
		const match = text.match(FFmpegBuilder.PROGRESS_PATTERN);
		if (!(match?.[1] && match[2] && match[3] && match[4])) return null;

		return {
			frame: Number.parseInt(match[1], 10),
			fps: Number.parseFloat(match[2]),
			time: match[3],
			speed: match[4],
		};
	}
}
