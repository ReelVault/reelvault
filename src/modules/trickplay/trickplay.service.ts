import { join } from "node:path";
import { type BunFile, file } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { MINUTE } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";
import { parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { buildSingleFrameExtractionCommand, buildSpriteTileCommand } from "@/integrations/ffmpeg/ffmpeg.frame-extract";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { isStorageBudgetError, resolveCoreArtifactsBudgetBytes } from "@/modules/artifacts/artifacts-budget.utils";
import { mediaRepository } from "@/repositories/media-files.repository";
import { writeCoreArtifact } from "@/services/artifacts/core-artifacts.writer";
import { mediaArtifactsService } from "@/services/artifacts/media-artifacts.service";
import { resourceAllocator } from "@/system/resource-allocator.service";
import { serverRescueService } from "@/system/server-rescue.service";
import { type StorageFailureReason, storageHealthService } from "@/system/storage-health.service";
import { chunk } from "@/utils/array.utils";
import { MIB } from "@/utils/bytes.utils";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { createDirectory, deleteTemporaryDirectory } from "@/utils/directory.utils";
import { DomainError, errorMessage } from "@/utils/domain.errors";
import { deleteFile } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { clamp } from "@/utils/math.utils";
import { mapConcurrent } from "@/utils/promise.utils";

const CONTENT_TYPE_WEBP = "image/webp";
/** The media file fields the preview generator reads: where it is, and how long it runs. */
const SOURCE_FIELDS = parseFields({ fields: "id,filePath,duration" });
const CONTENT_TYPE_VTT = "text/vtt";

/** One frame is a small, bounded read; 30 s is already generous on slow storage (60 s after the slow-core scale). */
const TRICKPLAY_FRAME_TIMEOUT_MS = MINUTE / 2;
const TRICKPLAY_FRAME_ATTEMPTS = 2;
/** Laying out the already-extracted tiles is cheap; this bounds a wedged filter. */
const TRICKPLAY_TILE_TIMEOUT_MS = 5 * MINUTE;
/** A black tile keeps the sprite usable when one frame cannot be read. */
const TRICKPLAY_PLACEHOLDER_TIMEOUT_MS = 30_000;
/** Pause the generator while the host is this full; the ARC-aware reading makes it meaningful on ZFS. */
const TRICKPLAY_PAUSE_MEMORY_PERCENT = 90;
const TRICKPLAY_MEMORY_POLL_MS = 10_000;
const TRICKPLAY_MEMORY_WAIT_MS = 5 * MINUTE;

interface TrickplaySprite {
	url: string;
	tileCount: number;
}

interface TrickplayCue {
	startSeconds: number;
	endSeconds: number;
	x: number;
	y: number;
	spriteUrl: string;
}

interface TrickplayLayout {
	tileWidth: number;
	tileHeight: number;
	columns: number;
	tilesPerSprite: number;
}

/** One generation run: the source file, the scratch dir its sprites are staged in, and the frame timing. */
interface TrickplayJob {
	mediaFileId: string;
	filePath: string;
	tempDir: string;
	layout: TrickplayLayout;
	frameCount: number;
	durationSeconds: number;
	effectiveInterval: number;
	peakChildRssBytes: number;
	/** The old previews this run replaces; the budget may count their bytes as reclaimed. */
	previousArtifactIds: string[];
	previousArtifactBytes: number;
}

export interface TrickplayGenerationResult {
	mediaFileId: string;
	frames: number;
	sprites: number;
	skipped?: "disabled" | "no-duration" | "storage-budget" | "storage-degraded" | "memory-pressure";
}

/** Progress is reported per frame and sprite so the worker can extend its stall deadline. */
export interface TrickplayGenerationHooks {
	onProgress?: (() => void) | undefined;
}

function resolveLayout(): TrickplayLayout {
	const tileWidth = serverConfig.trickplay.tileWidth;
	const columns = serverConfig.trickplay.columns;

	return {
		tileWidth,
		tileHeight: Math.round((tileWidth * 9) / 16 / 2) * 2,
		columns,
		tilesPerSprite: columns * columns,
	};
}

/**
 * xstack needs a full grid (and ≥2 inputs for its relative layout) — pad
 * the last chunk by repeating its final timestamp; unused tiles are never
 * referenced by the VTT.
 */
function padLastChunk(chunks: number[][], tilesPerSprite: number): void {
	const lastChunk = chunks.at(-1);
	const padSource = lastChunk?.at(-1);
	if (lastChunk && padSource !== undefined) {
		while (lastChunk.length < tilesPerSprite) lastChunk.push(padSource);
	}
}

/** Cue timeline spans the whole duration; each cue points at its tile inside its sprite. */
function buildCues(job: TrickplayJob, sprites: readonly TrickplaySprite[]): TrickplayCue[] {
	const { layout, frameCount, durationSeconds, effectiveInterval } = job;
	const cues: TrickplayCue[] = [];
	for (let index = 0; index < frameCount; index++) {
		const spriteIndex = Math.floor(index / layout.tilesPerSprite);
		const positionInSprite = index % layout.tilesPerSprite;
		cues.push({
			startSeconds: index * effectiveInterval,
			endSeconds: Math.min((index + 1) * effectiveInterval, durationSeconds),
			x: (positionInSprite % layout.columns) * layout.tileWidth,
			y: Math.floor(positionInSprite / layout.columns) * layout.tileHeight,
			spriteUrl: sprites[spriteIndex]?.url ?? sprites[0]?.url ?? "",
		});
	}

	return cues;
}

/**
 * Built-in trickplay generator: extracts preview frames, tiles them into sprite
 * sheets and registers sprite + WebVTT artifacts (`kind: "trickplay"`,
 * `pluginId: "core"`) in the shared media-artifacts store. The artifact shape is
 * exactly what the player's trickplay hook parses (WebVTT cues with
 * `<sprite url>#xywh=x,y,w,h` payloads), which makes the external plugin
 * `org.reelvault.trickplay` unnecessary. Core writes bypass the per-plugin
 * artifact quota and use the configurable core budget instead.
 */
class TrickplayService {
	readonly serviceName = "TrickplayService";
	readonly logger = createLogger("TrickplayService");

	async generateForMediaFile(
		mediaFileId: string,
		signal?: AbortSignal,
		hooks?: TrickplayGenerationHooks,
	): Promise<TrickplayGenerationResult> {
		throwIfAborted(signal);
		if (!serverConfig.trickplay.enabled) {
			return { mediaFileId, frames: 0, sprites: 0, skipped: "disabled" };
		}

		const source = await mediaRepository.findByPrimaryId({ primaryId: mediaFileId, fields: SOURCE_FIELDS });

		if (!source?.filePath)
			throw new DomainError("not_found", `Trickplay generation failed: media file '${mediaFileId}' not found`, {
				code: "media_file_not_found",
			});

		// A file whose storage just failed repeatedly is skipped until the health
		// cooldown passes — spawning another ffmpeg for it only repeats the hang.
		if (storageHealthService.isFileBlocked(source.filePath)) {
			this.logger.warn("Trickplay skipped: storage marked degraded", {
				mediaFileId,
				filePath: source.filePath,
				root: storageHealthService.getRootForPath(source.filePath),
			});

			return { mediaFileId, frames: 0, sprites: 0, skipped: "storage-degraded" };
		}

		const durationSeconds = source.duration ?? 0;
		if (durationSeconds <= 0) return { mediaFileId, frames: 0, sprites: 0, skipped: "no-duration" };

		const previousArtifactIds = await this.previousTrickplayArtifactIds(mediaFileId);
		const previousArtifactBytes = await mediaArtifactsService.getStoredBytesByIds(mediaFileId, previousArtifactIds);
		// Stop before touching the previous generation when even dropping this
		// file's own artifacts would not bring core storage back under budget.
		if (await this.exceedsArtifactBudget(mediaFileId, previousArtifactBytes)) {
			return { mediaFileId, frames: 0, sprites: 0, skipped: "storage-budget" };
		}

		if (!(await this.waitForBackgroundHeadroom(signal, hooks))) {
			this.logger.warn("Trickplay deferred: server memory pressure did not clear", { mediaFileId });

			return { mediaFileId, frames: 0, sprites: 0, skipped: "memory-pressure" };
		}

		const layout = resolveLayout();
		const intervalSeconds = Math.max(1, serverConfig.trickplay.intervalSeconds);
		const frameCount = clamp(Math.floor(durationSeconds / intervalSeconds), 1, serverConfig.trickplay.maxFramesPerFile);
		const effectiveInterval = durationSeconds / frameCount;
		// Sample the middle of each interval — avoids black frames at scene starts.
		const timestampsMs = Array.from({ length: frameCount }, (_, index) =>
			Math.round(((index + 0.5) * durationSeconds * 1000) / frameCount),
		);

		const tempDir = join(serverConfig.paths.transcodeTmp, `trickplay_${mediaFileId}_${crypto.randomUUID()}`);
		if (!(await createDirectory(tempDir))) {
			// create() logs the underlying fs error and returns false — fail with the
			// actual cause instead of later reporting an empty sprite.
			throw new DomainError("internal", "Trickplay temp directory could not be created", { code: "trickplay_temp_dir_failed" });
		}

		const job: TrickplayJob = {
			mediaFileId,
			filePath: source.filePath,
			tempDir,
			layout,
			frameCount,
			durationSeconds,
			effectiveInterval,
			peakChildRssBytes: 0,
			previousArtifactIds,
			previousArtifactBytes,
		};

		try {
			return await this.runGeneration(job, timestampsMs, signal, hooks);
		} finally {
			await deleteTemporaryDirectory(tempDir);
		}
	}

	/** The generation itself; the caller owns the temp directory's lifetime. */
	private async runGeneration(
		job: TrickplayJob,
		timestampsMs: readonly number[],
		signal: AbortSignal | undefined,
		hooks: TrickplayGenerationHooks | undefined,
	): Promise<TrickplayGenerationResult> {
		const { layout, mediaFileId } = job;
		const chunks = chunk(timestampsMs, layout.tilesPerSprite);
		padLastChunk(chunks, layout.tilesPerSprite);

		this.logger.info("Trickplay generation started", {
			mediaFileId,
			filePath: job.filePath,
			durationSeconds: job.durationSeconds,
			frames: job.frameCount,
			sprites: chunks.length,
			columns: layout.columns,
		});
		throwIfAborted(signal);

		try {
			const sprites = await this.extractSprites(job, chunks, signal, hooks);
			throwIfAborted(signal);

			// The new generation is complete; drop the old one only after the new
			// cue track is stored — a missing new cue track must never be paired
			// with a deleted old one.
			// awaits: sequential — the new cue track is stored before the old generation is dropped
			await writeCoreArtifact(
				{
					mediaFileId,
					kind: "trickplay",
					contentType: CONTENT_TYPE_VTT,
					content: new TextEncoder().encode(buildTrickplayVtt(buildCues(job, sprites), layout.tileWidth, layout.tileHeight)),
				},
				{ reclaimedBytes: job.previousArtifactBytes },
			);

			await mediaArtifactsService.deleteByIds(mediaFileId, job.previousArtifactIds).catch((error: unknown) => {
				this.logger.warn("Failed to remove the previous trickplay generation", { mediaFileId, error: errorMessage(error) });
			});

			this.logger.info("Trickplay generated", {
				mediaFileId,
				frames: job.frameCount,
				sprites: sprites.length,
				peakChildRssMb: Math.round(job.peakChildRssBytes / MIB),
				parentRssMb: Math.round(process.memoryUsage().rss / MIB),
			});

			return { mediaFileId, frames: job.frameCount, sprites: sprites.length };
		} catch (error) {
			// Remove only the artifacts this attempt wrote. The previous
			// generation stays available for playback until a new one is complete.
			await this.removeNewArtifacts(mediaFileId, job.previousArtifactIds);
			const skipped = this.skipReasonFor(error);
			if (skipped === "storage-budget") {
				// Running out of budget is a storage condition, not a generation
				// failure — skip so the file is retried once space is freed.
				this.logger.warn("Trickplay generation stopped: artifact storage budget reached", { mediaFileId });
			}

			if (skipped) return { mediaFileId, frames: 0, sprites: 0, skipped };

			throw error;
		}
	}

	/** Maps the handled non-fatal generation errors to their skip reason. */
	private skipReasonFor(error: unknown): TrickplayGenerationResult["skipped"] | undefined {
		if (isStorageBudgetError(error)) return "storage-budget";
		if (error instanceof DomainError && error.code === "trickplay_storage_degraded") return "storage-degraded";
		if (error instanceof DomainError && error.code === "trickplay_memory_pressure") return "memory-pressure";

		return undefined;
	}

	/** The IDs of the core generation's artifacts, captured before a replacement run. */
	private async previousTrickplayArtifactIds(mediaFileId: string): Promise<string[]> {
		const artifacts = await mediaArtifactsService.list(mediaFileId);

		return artifacts
			.filter((artifact) => artifact.pluginId === CORE_ARTIFACTS_OWNER && artifact.kind === "trickplay")
			.map((artifact) => artifact.id);
	}

	/** Deletes the core artifacts this attempt wrote, leaving the previous generation and plugins untouched. */
	private async removeNewArtifacts(mediaFileId: string, previousIds: readonly string[]): Promise<void> {
		try {
			const previous = new Set(previousIds);
			const current = await mediaArtifactsService.list(mediaFileId);
			const newIds = current
				.filter((artifact) => artifact.pluginId === CORE_ARTIFACTS_OWNER && artifact.kind === "trickplay" && !previous.has(artifact.id))
				.map((artifact) => artifact.id);

			if (newIds.length > 0) await mediaArtifactsService.deleteByIds(mediaFileId, newIds);
		} catch (error) {
			this.logger.warn("Failed to remove partial trickplay artifacts", { mediaFileId, error: errorMessage(error) });
		}
	}

	/**
	 * Waits for memory pressure to clear, bounded so one job cannot hold the queue
	 * forever. The arc-aware reading makes the percentage meaningful on ZFS.
	 */
	private async waitForBackgroundHeadroom(signal: AbortSignal | undefined, hooks: TrickplayGenerationHooks | undefined): Promise<boolean> {
		const deadline = Date.now() + TRICKPLAY_MEMORY_WAIT_MS;

		while (Date.now() < deadline) {
			throwIfAborted(signal);

			const memoryPercent = resourceAllocator.getCurrentSnapshot()?.memory.percent ?? 0;
			const pressure = memoryPercent >= TRICKPLAY_PAUSE_MEMORY_PERCENT;
			const throttling = serverRescueService.isThrottling();
			if (!(pressure || throttling)) return true;

			hooks?.onProgress?.();
			await Bun.sleep(TRICKPLAY_MEMORY_POLL_MS);
		}

		return false;
	}

	/** Whether dropping this file's own artifacts would still leave core storage over budget. */
	private async exceedsArtifactBudget(mediaFileId: string, existingBytes: number): Promise<boolean> {
		const [budgetBytes, storedBytes] = await Promise.all([
			resolveCoreArtifactsBudgetBytes(),
			mediaArtifactsService.getStoredBytes(CORE_ARTIFACTS_OWNER),
		]);
		if (storedBytes - existingBytes < budgetBytes) return false;

		this.logger.warn("Trickplay generation skipped: artifact storage budget exhausted", {
			mediaFileId,
			storedBytes,
			existingBytes,
			budgetBytes,
		});

		return true;
	}

	/**
	 * Renders each timestamp chunk into one WebP sprite sheet and stores it as a
	 * core trickplay artifact.
	 *
	 * Each grid is built from single-frame reads instead of opening one decoder
	 * per seek inside a single ffmpeg process. A grid used to hold 25 decoders
	 * at once, which multiplied the memory peak by the tile count and turned one
	 * seek per tile into 25 concurrent random reads on the library disk.
	 */
	private async extractSprites(
		job: TrickplayJob,
		chunks: number[][],
		signal: AbortSignal | undefined,
		hooks: TrickplayGenerationHooks | undefined,
	): Promise<TrickplaySprite[]> {
		// A failed grid (or a cancelled worker) aborts the siblings, so a
		// generation error does not leave ffmpeg processes decoding frames
		// nobody will read.
		const controller = new AbortController();
		const runSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
		let rendered: Array<{ file: BunFile; tileCount: number }>;
		try {
			rendered = await mapConcurrent(
				chunks,
				systemResourcesService.getTrickplayConcurrency(),
				async (chunkTimeMs, spriteIndex) => {
					if (!(await this.waitForBackgroundHeadroom(runSignal, hooks))) {
						throw new DomainError("timeout", "Trickplay paused while the server is under memory pressure", {
							code: "trickplay_memory_pressure",
						});
					}

					return await this.renderSprite(job, spriteIndex, chunkTimeMs, runSignal, hooks);
				},
				runSignal,
			);
		} catch (error) {
			controller.abort();

			throw error;
		}

		const sprites: TrickplaySprite[] = [];
		for (const sprite of rendered) {
			// The artifact write streams the BunFile straight to its storage
			// path (no full buffer through JS) and deletes the temp source
			// afterwards — writeFileWithRollback owns that cleanup.
			const written = await writeCoreArtifact(
				{
					mediaFileId: job.mediaFileId,
					kind: "trickplay",
					contentType: CONTENT_TYPE_WEBP,
					content: sprite.file,
				},
				{ reclaimedBytes: job.previousArtifactBytes },
			);
			sprites.push({ url: written.url, tileCount: sprite.tileCount });
			hooks?.onProgress?.();
		}

		return sprites;
	}

	/** Builds one grid from bounded single-frame reads into a single WebP sheet. */
	private async renderSprite(
		job: TrickplayJob,
		spriteIndex: number,
		chunkTimeMs: number[],
		signal: AbortSignal,
		hooks: TrickplayGenerationHooks | undefined,
	): Promise<{ file: BunFile; tileCount: number }> {
		const { layout } = job;
		const framesDir = join(job.tempDir, `frames_${spriteIndex}`);
		const spritePath = join(job.tempDir, `sprite_${spriteIndex}.webp`);

		if (!(await createDirectory(framesDir))) {
			throw new DomainError("internal", "Trickplay frame directory could not be created", {
				code: "trickplay_temp_dir_failed",
			});
		}

		try {
			let successfulFrames = 0;
			await mapConcurrent(
				chunkTimeMs,
				systemResourcesService.getTrickplayFrameConcurrency(),
				async (timeMs, frameIndex) => {
					throwIfAborted(signal);
					if (storageHealthService.isFileBlocked(job.filePath)) {
						throw new DomainError("internal", "Storage marked degraded while reading trickplay frames", {
							code: "trickplay_storage_degraded",
						});
					}

					const framePath = join(framesDir, `frame_${String(frameIndex).padStart(4, "0")}.webp`);
					const extracted = await this.extractFrame(job, timeMs, framePath, signal);
					if (extracted) {
						successfulFrames++;
						hooks?.onProgress?.();

						return;
					}

					await this.writePlaceholderFrame(job, framePath, signal);
					hooks?.onProgress?.();
				},
				signal,
			);

			if (successfulFrames === 0) {
				storageHealthService.recordFailure(job.filePath, "frame_error");
				throw new DomainError("internal", "Trickplay extraction produced no usable frames", { code: "trickplay_no_frames" });
			}

			const rows = Math.ceil(chunkTimeMs.length / layout.columns);
			const command = buildSpriteTileCommand(join(framesDir, "frame_%04d.webp"), layout.columns, rows, "webp", spritePath);
			const result = await ffMpegService.runToCompletion(command, {
				timeoutMs: systemResourcesService.scaledTimeoutMs(TRICKPLAY_TILE_TIMEOUT_MS),
				stdout: "ignore",
				maxOutputBytes: serverConfig.plugins.ffmpeg.maxOutputBytes,
				signal,
			});
			this.trackPeakRss(job, result);

			if (result.exitCode !== 0) {
				const exitText = result.exitCode === null ? "signal" : String(result.exitCode);
				storageHealthService.recordFailure(job.filePath, "grid_error");
				throw new DomainError("internal", `Trickplay sprite assembly failed (exit ${exitText}): ${result.stderr.slice(-1_500)}`, {
					code: "trickplay_extraction_failed",
				});
			}

			const spriteFile = file(spritePath);
			if (spriteFile.size === 0) {
				storageHealthService.recordFailure(job.filePath, "empty_sprite");
				throw new DomainError("internal", `Trickplay sprite is empty: ${result.stderr.slice(-1_500)}`, {
					code: "trickplay_empty_sprite",
				});
			}

			storageHealthService.recordSuccess(job.filePath);

			return { file: spriteFile, tileCount: chunkTimeMs.length };
		} finally {
			await deleteTemporaryDirectory(framesDir);
		}
	}

	/** Reads one timestamp, retrying a transient read before a placeholder is used. */
	private async extractFrame(job: TrickplayJob, timeMs: number, framePath: string, signal: AbortSignal): Promise<boolean> {
		const { layout } = job;
		let lastReason: StorageFailureReason = "frame_error";

		for (let attempt = 1; attempt <= TRICKPLAY_FRAME_ATTEMPTS; attempt++) {
			throwIfAborted(signal);
			try {
				const command = buildSingleFrameExtractionCommand({
					inputPath: job.filePath,
					timeMs,
					width: layout.tileWidth,
					height: layout.tileHeight,
					format: "webp",
					outputPath: framePath,
				});
				const result = await ffMpegService.runToCompletion(command, {
					timeoutMs: systemResourcesService.scaledTimeoutMs(TRICKPLAY_FRAME_TIMEOUT_MS),
					stdout: "ignore",
					maxOutputBytes: serverConfig.plugins.ffmpeg.maxOutputBytes,
					signal,
				});
				this.trackPeakRss(job, result);

				if (result.exitCode === 0 && file(framePath).size > 0) return true;

				if (result.exitCode === 0) {
					this.logger.warn("Trickplay frame is empty", { mediaFileId: job.mediaFileId, timeMs, attempt });
				} else {
					lastReason = "frame_error";
					this.logger.warn("Trickplay frame extraction failed", {
						mediaFileId: job.mediaFileId,
						timeMs,
						attempt,
						exitCode: result.exitCode,
						stderr: result.stderr.slice(-1_000),
					});
				}
			} catch (error) {
				if (signal.aborted) throw error;

				lastReason = error instanceof DomainError && error.code === "ffmpeg.timeout" ? "frame_timeout" : "frame_error";
				this.logger.warn("Trickplay frame extraction threw", {
					mediaFileId: job.mediaFileId,
					timeMs,
					attempt,
					error: errorMessage(error),
				});
			}

			await deleteFile(framePath);
		}

		storageHealthService.recordFailure(job.filePath, lastReason);

		return false;
	}

	/** A black tile keeps the rest of the sprite usable when one frame is unreadable. */
	private async writePlaceholderFrame(job: TrickplayJob, framePath: string, signal: AbortSignal): Promise<void> {
		const { layout } = job;
		const command = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			`color=c=black:s=${layout.tileWidth}x${layout.tileHeight}:d=1`,
			"-frames:v",
			"1",
			"-c:v",
			"libwebp",
			"-y",
			framePath,
		];
		const result = await ffMpegService.runToCompletion(command, {
			timeoutMs: TRICKPLAY_PLACEHOLDER_TIMEOUT_MS,
			stdout: "ignore",
			signal,
		});
		this.trackPeakRss(job, result);

		if (result.exitCode !== 0 || file(framePath).size === 0) {
			throw new DomainError("internal", `Trickplay placeholder frame failed: ${result.stderr.slice(-500)}`, {
				code: "trickplay_placeholder_failed",
			});
		}
	}

	private trackPeakRss(job: TrickplayJob, result: { maxRssBytes?: number | undefined }): void {
		if (result.maxRssBytes === undefined) return;

		job.peakChildRssBytes = Math.max(job.peakChildRssBytes, result.maxRssBytes);
	}
}

function vttTimestamp(seconds: number): string {
	// Round to whole milliseconds first, then split — `secs.toFixed(3)` alone
	// could emit `00:00:60.000` for values within half a millisecond of a minute.
	const totalMs = Math.max(0, Math.round(seconds * 1000));
	const hours = Math.floor(totalMs / 3_600_000);
	const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
	const secs = Math.floor((totalMs % 60_000) / 1000);
	const millis = totalMs % 1000;

	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** WebVTT with `#xywh=` sprite payloads — the exact format `use-player-trickplay` parses. */
function buildTrickplayVtt(cues: readonly TrickplayCue[], tileWidth: number, tileHeight: number): string {
	const blocks = cues.map((cue) => {
		const payload = `${cue.spriteUrl}#xywh=${cue.x},${cue.y},${tileWidth},${tileHeight}`;

		return `${vttTimestamp(cue.startSeconds)} --> ${vttTimestamp(cue.endSeconds)}\n${payload}`;
	});

	return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

export const trickplayService = new TrickplayService();
