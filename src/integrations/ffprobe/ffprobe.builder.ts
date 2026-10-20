import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { type SpawnCollectOptions, type SpawnCollectResult, spawnAndCollect } from "@/integrations/ffmpeg/ffmpeg.process-runner";
import { DomainError } from "@/utils/domain.errors";
import { fileVersionSignature } from "@/utils/file.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { createSemaphore, raceWithAbort } from "@/utils/promise.utils";
import { isRecord } from "@/utils/type.utils";
import type { FFProbePacket, FFProbeResult } from "./ffprobe.types";

// Full FFProbeResult rows are 5-50 KB — size scales with installed RAM.
const ffprobeCache = new MemoryCache<unknown>({
	name: "ffprobe",
	maxSize: systemResourcesService.getRamScaled(100, 250, 2000),
});

// One probe-process budget for every ffprobe caller (scanner, keyframe seek,
// capability checks). Acquired inside the cached loader, so a caller that aborts
// while a shared probe runs does not release the slot the process still holds.
const probeSemaphore = createSemaphore(() => systemResourcesService.getFfprobeConcurrency());

function isFFProbeResult(value: unknown): value is FFProbeResult {
	return isRecord(value) && Array.isArray(value.streams) && isRecord(value.format);
}

function isFFProbePacket(value: unknown): value is FFProbePacket {
	return (
		isRecord(value) &&
		(value.pts_time === undefined || typeof value.pts_time === "string") &&
		(value.flags === undefined || typeof value.flags === "string")
	);
}

/** A packet listing: ffprobe answers `-show_entries packet=…` with the packets alone. */
function isFFProbePacketList(value: unknown): value is { packets: FFProbePacket[] } {
	return isRecord(value) && Array.isArray(value.packets) && value.packets.every(isFFProbePacket);
}

export function clearFFProbeCache(): void {
	ffprobeCache.clear();
}

export class FFProbeBuilder {
	private readonly args: string[] = ["-v", "error", "-of", "json"];
	/**
	 * The probe process boundary. Injectable so the probe's output handling can
	 * be tested without spawning ffprobe.
	 */
	private readonly spawn: (options: SpawnCollectOptions) => Promise<SpawnCollectResult>;

	constructor(spawn: (options: SpawnCollectOptions) => Promise<SpawnCollectResult> = spawnAndCollect) {
		this.spawn = spawn;
	}

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
		const parsed = await this.executeParsed(filePath, "format", signal);
		if (!isFFProbeResult(parsed)) throw new DomainError("internal", "ffprobe returned no usable data", { code: "ffprobe_invalid_output" });

		return parsed;
	}

	/**
	 * A packet listing. ffprobe answers `-show_entries packet=…` with the packets
	 * alone — no streams, no format — so the format probe's shape check does not
	 * apply here.
	 */
	async executePackets(filePath: string, signal?: AbortSignal): Promise<FFProbePacket[]> {
		const parsed = await this.executeParsed(filePath, "packets", signal);
		if (!isFFProbePacketList(parsed))
			throw new DomainError("internal", "ffprobe returned no packet data", { code: "ffprobe_invalid_output" });

		return parsed.packets;
	}

	private async executeParsed(filePath: string, shape: "format" | "packets", signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) throw signal.reason ?? new Error("FFprobe aborted");

		const statSignature = await fileVersionSignature(filePath);

		// The shape is part of the key: the same arguments can be read as a
		// format probe or as a packet listing, and the two hold different data.
		const cacheKey = `${filePath}:${statSignature}:${shape}:${this.args.join(" ")}`;
		const args = [...this.args];
		const promise = ffprobeCache.getOrSet(cacheKey, () => this.probe(filePath, args));

		return await raceWithAbort(promise, signal, "FFprobe aborted");
	}

	private async probe(filePath: string, args: string[]): Promise<unknown> {
		await probeSemaphore.acquire();
		try {
			const {
				exitCode,
				stdout: output,
				stderr: errorOutput,
				timedOut,
			} = await this.spawn({
				cmd: [serverConfig.ffprobe.path, ...args, filePath],
				timeoutMs: serverConfig.ffprobe.timeoutMs,
				purpose: "probe",
				maxBuffer: serverConfig.ffprobe.maxOutputBytes,
			});

			try {
				if (timedOut) {
					throw new DomainError("timeout", `FFprobe timed out after ${serverConfig.ffprobe.timeoutMs}ms`, { code: "ffprobe_timeout" });
				}

				if (exitCode !== 0) {
					const details = errorOutput.trim();
					throw new DomainError("internal", `FFprobe exited with code ${exitCode}${details ? `: ${details}` : ""}`, {
						code: "ffprobe_exit_error",
					});
				}

				return JSON.parse(output) as unknown;
			} catch (error) {
				if (error instanceof DomainError && (error.category === "timeout" || error.category === "internal")) throw error;

				let msg: string;
				if (error instanceof Error) msg = error.message;
				else if (typeof error === "string") msg = error;
				else msg = "Unknown error";

				throw new DomainError("internal", `FFprobe execution failed: ${msg}`, {
					cause: error,
					code: "ffprobe_execution_failed",
					details: error instanceof Error ? error : new Error(msg),
				});
			}
		} finally {
			probeSemaphore.release();
		}
	}
}
