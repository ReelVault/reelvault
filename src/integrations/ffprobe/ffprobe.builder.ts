import { spawnAndCollect } from "@/integrations/ffmpeg/ffmpeg.process-runner";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { InternalError, RequestTimeoutError } from "@/utils/errors";
import { FileUtils, fileStatSignature } from "@/utils/file.utils";
import { MemoryCache } from "@/utils/memory-cache";
import { isRecord } from "@/utils/type.utils";
import type { FFProbeResult } from "./ffprobe.types";

// Full FFProbeResult rows are 5-50 KB — size scales with installed RAM.
const ffprobeCache = new MemoryCache<FFProbeResult>({
	name: "ffprobe",
	maxSize: systemResourcesService.getRamScaledCacheEntries(100, 250, 2000),
});

function isFFProbeResult(value: unknown): value is FFProbeResult {
	return isRecord(value) && Array.isArray(value.streams) && isRecord(value.format);
}

export function clearFFProbeCache(): void {
	ffprobeCache.clear();
}

/**
 * Waits for a shared probe but lets each caller stop waiting on its own abort.
 * The shared probe itself is not bound to any caller's signal — a follower's
 * abort must not kill a probe another caller is still awaiting.
 */
async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;

	if (signal.aborted) throw signal.reason ?? new Error("FFprobe aborted");

	const abort = new Promise<never>((_resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("FFprobe aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
	});

	return await Promise.race([promise, abort]);
}

export class FFProbeBuilder {
	private readonly args: string[] = ["-v", "error", "-of", "json"];

	selectStreams(type: "v" | "a" | "video" | "audio", index = 0) {
		this.args.push("-select_streams", `${type.charAt(0)}:${index}`);

		return this;
	}

	showFormat() {
		this.args.push("-show_format");

		return this;
	}

	showStreams() {
		this.args.push("-show_streams");

		return this;
	}

	includeChapters() {
		this.args.push("-show_chapters");

		return this;
	}

	addArg(key: string, value?: string) {
		this.args.push(key);
		if (value) this.args.push(value);

		return this;
	}

	async execute(filePath: string, signal?: AbortSignal): Promise<FFProbeResult> {
		if (signal?.aborted) throw signal.reason ?? new Error("FFprobe aborted");

		const fileStat = await FileUtils.getStats(filePath);
		const statSignature = fileStat ? fileStatSignature(fileStat) : "";

		const cacheKey = `${filePath}:${statSignature}:${this.args.join(" ")}`;
		const args = [...this.args];
		const promise = ffprobeCache.getOrSet(cacheKey, () => this.probe(filePath, args));

		return await raceWithAbort(promise, signal);
	}

	private async probe(filePath: string, args: string[]): Promise<FFProbeResult> {
		const {
			exitCode,
			stdout: output,
			stderr: errorOutput,
			timedOut,
		} = await spawnAndCollect({
			cmd: [serverConfig.ffprobe.path, ...args, filePath],
			timeoutMs: serverConfig.ffprobe.timeoutMs,
			purpose: "probe",
			maxBuffer: serverConfig.ffprobe.maxOutputBytes,
		});

		try {
			if (timedOut) {
				throw new RequestTimeoutError(`FFprobe timed out after ${serverConfig.ffprobe.timeoutMs}ms`, { code: "ffprobe_timeout" });
			}

			if (exitCode !== 0) {
				const details = errorOutput.trim();
				throw new InternalError(`FFprobe exited with code ${exitCode}${details ? `: ${details}` : ""}`, { code: "ffprobe_exit_error" });
			}

			const parsed: unknown = JSON.parse(output);
			if (!isFFProbeResult(parsed)) throw new InternalError("ffprobe returned no usable data", { code: "ffprobe_invalid_output" });

			return parsed;
		} catch (error) {
			if (error instanceof RequestTimeoutError || error instanceof InternalError) throw error;

			let msg: string;
			if (error instanceof Error) msg = error.message;
			else if (typeof error === "string") msg = error;
			else msg = "Unknown error";

			throw new InternalError(`FFprobe execution failed: ${msg}`, {
				code: "ffprobe_execution_failed",
				details: error instanceof Error ? error : new Error(msg),
			});
		}
	}
}
