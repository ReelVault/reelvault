import fs, { mkdirSync } from "node:fs";
import { serverConfig } from "@/server.config";
import { errorMessage } from "@/utils/errors";
import { currentLogDate } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";

const UNSAFE_ID_REGEX = /[^a-zA-Z0-9_-]/g;

export interface FfmpegOperationLogOptions {
	operationId: string;
	mode: "direct-stream" | "transcode";
	inputPath: string;
	outputPath: string;
	command: readonly string[];
	logsDirectory?: string | undefined;
}

export class FfmpegOperationLog {
	readonly filePath: string;
	private readonly stream: fs.WriteStream;
	private readonly startedAt = Date.now();
	private finished = false;

	constructor(options: FfmpegOperationLogOptions) {
		const dateDirectory = PathUtils.join(options.logsDirectory ?? serverConfig.paths.logs, "ffmpeg", currentLogDate());
		// Synchronous create before the stream opens: a fire-and-forget mkdir raced
		// the first write and silently dropped the first log of each day (ENOENT).
		try {
			mkdirSync(dateDirectory, { recursive: true });
		} catch {
			// Best-effort; the stream's error handler still swallows write failures.
		}

		const modePrefix = options.mode === "transcode" ? "FFmpeg.Transcode" : "FFmpeg.DirectStream";
		const dateStr = new Date(this.startedAt).toISOString().replace("T", "_").replaceAll(":", "-").slice(0, 19);
		const safeOperationId = options.operationId.replaceAll(UNSAFE_ID_REGEX, "_");
		this.filePath = PathUtils.join(dateDirectory, `${modePrefix}-${dateStr}_${safeOperationId}.log`);
		this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
		this.stream.on("error", () => {
			/* intentionally empty */
		});
		this.writeLine("=== FFmpeg operation started ===");
		this.writeLine(`operationId: ${options.operationId}`);
		this.writeLine(`mode: ${options.mode}`);
		this.writeLine(`input: ${options.inputPath}`);
		this.writeLine(`output: ${options.outputPath}`);
		this.writeLine(`command: ${options.command.map(quoteShellArgument).join(" ")}`);
		this.writeLine(`startedAt: ${new Date(this.startedAt).toISOString()}`);
	}

	writeProcessId(processId: number): void {
		this.writeLine(`processId: ${processId}`);
	}

	writeStderr(text: string): void {
		this.writeLine(`[stderr] ${text.trimEnd()}`);
	}

	writeProgress(text: string): void {
		this.writeLine(`[progress] ${text.trimEnd()}`);
	}

	finish(exitCode: number | null, signalCode: number | null, error?: unknown): Promise<void> {
		if (this.finished) return Promise.resolve();

		this.writeLine(`exitCode: ${exitCode ?? "null"}`);
		this.writeLine(`signalCode: ${signalCode ?? "null"}`);
		this.writeLine(`finishedAt: ${new Date().toISOString()}`);
		this.writeLine(`durationMs: ${Date.now() - this.startedAt}`);

		// TODO: consider using errorMessage() from @/utils/errors.ts once we decide whether stack traces are needed in operation logs
		if (error) this.writeLine(`error: ${error instanceof Error ? (error.stack ?? error.message) : errorMessage(error)}`);

		this.writeLine("=== FFmpeg operation finished ===");
		this.finished = true;

		return new Promise((resolve) => {
			this.stream.end(resolve);
		});
	}

	private writeLine(line: string): void {
		if (this.finished) return;

		this.stream.write(`${line}\n`);
	}
}

function quoteShellArgument(argument: string): string {
	return `'${argument.replaceAll("'", "'\\''")}'`;
}
