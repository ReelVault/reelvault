import { join } from "node:path";
import { type BunFile, file } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { FFMPEG_TIMEOUT_MS } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";
import { parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { buildSpriteExtractionCommand } from "@/integrations/ffmpeg/ffmpeg.frame-extract";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { isStorageBudgetError, resolveCoreArtifactsBudgetBytes } from "@/modules/artifacts/artifacts-budget.utils";
import { mediaRepository } from "@/repositories/media-files.repository";
import { writeCoreArtifact } from "@/services/artifacts/core-artifacts.writer";
import { mediaArtifactsService } from "@/services/artifacts/media-artifacts.service";
import { chunk } from "@/utils/array.utils";
import { createDirectory, deleteDirectory } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { clamp } from "@/utils/math.utils";
import { mapConcurrent } from "@/utils/promise.utils";

const CONTENT_TYPE_WEBP = "image/webp";
/** The media file fields the preview generator reads: where it is, and how long it runs. */
const SOURCE_FIELDS = parseFields({ fields: "id,filePath,duration" });
const CONTENT_TYPE_VTT = "text/vtt";

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
}

export interface TrickplayGenerationResult {
	mediaFileId: string;
	frames: number;
	sprites: number;
	skipped?: "disabled" | "no-duration" | "storage-budget";
}

/** Removes the core previews of one media file. */
async function removePreviews(mediaFileId: string): Promise<number> {
	return await mediaArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, "trickplay", CORE_ARTIFACTS_OWNER);
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

	async generateForMediaFile(mediaFileId: string): Promise<TrickplayGenerationResult> {
		if (!serverConfig.trickplay.enabled) {
			return { mediaFileId, frames: 0, sprites: 0, skipped: "disabled" };
		}

		const source = await mediaRepository.findByPrimaryId({ primaryId: mediaFileId, fields: SOURCE_FIELDS });

		if (!source?.filePath)
			throw new DomainError("not_found", `Trickplay generation failed: media file '${mediaFileId}' not found`, {
				code: "media_file_not_found",
			});

		const durationSeconds = source.duration ?? 0;
		if (durationSeconds <= 0) return { mediaFileId, frames: 0, sprites: 0, skipped: "no-duration" };

		// Stop before touching the previous generation when even dropping this
		// file's own artifacts would not bring core storage back under budget.
		if (await this.exceedsArtifactBudget(mediaFileId)) {
			return { mediaFileId, frames: 0, sprites: 0, skipped: "storage-budget" };
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
		};

		try {
			const chunks = chunk(timestampsMs, layout.tilesPerSprite);
			padLastChunk(chunks, layout.tilesPerSprite);

			// Idempotent regeneration: remove the PREVIOUS generation before writing
			// the new sprites. Deleting after the loop (as before) removed the
			// sprites we just wrote, leaving the VTT pointing at missing artifacts.
			await removePreviews(mediaFileId);

			let sprites: TrickplaySprite[];
			try {
				sprites = await this.extractSprites(job, chunks);

				await writeCoreArtifact({
					mediaFileId,
					kind: "trickplay",
					contentType: CONTENT_TYPE_VTT,
					content: new TextEncoder().encode(buildTrickplayVtt(buildCues(job, sprites), layout.tileWidth, layout.tileHeight)),
				});
			} catch (error) {
				// Remove partial sprites so a failed generation leaves no artifact
				// rows/files without their VTT behind.
				await removePreviews(mediaFileId).catch(() => {
					// best-effort cleanup
				});

				if (isStorageBudgetError(error)) {
					// Running out of budget is a storage condition, not a generation
					// failure — skip so the file is retried once space is freed.
					this.logger.warn("Trickplay generation stopped: artifact storage budget reached", { mediaFileId });

					return { mediaFileId, frames: 0, sprites: 0, skipped: "storage-budget" };
				}

				throw error;
			}

			this.logger.info("Trickplay generated", { mediaFileId, frames: frameCount, sprites: sprites.length });

			return { mediaFileId, frames: frameCount, sprites: sprites.length };
		} finally {
			await deleteDirectory(tempDir);
		}
	}

	/** Whether dropping this file's own artifacts would still leave core storage over budget. */
	private async exceedsArtifactBudget(mediaFileId: string): Promise<boolean> {
		const [budgetBytes, storedBytes, existingBytes] = await Promise.all([
			resolveCoreArtifactsBudgetBytes(),
			mediaArtifactsService.getStoredBytes(CORE_ARTIFACTS_OWNER),
			mediaArtifactsService.getMediaFileStoredBytes(mediaFileId, CORE_ARTIFACTS_OWNER),
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
	 * The grids are independent, so they render concurrently: one grid decodes a
	 * whole row of seeks out of the source, and rendering them one after another
	 * left the machine idle between grids. The budget comes from the background
	 * cores, so a slow box still renders one grid at a time.
	 */
	private async extractSprites(job: TrickplayJob, chunks: number[][]): Promise<TrickplaySprite[]> {
		// A failed grid aborts the siblings, so a generation error does not leave
		// ffmpeg processes decoding frames nobody will read.
		const controller = new AbortController();
		let rendered: Array<{ file: BunFile; tileCount: number }>;
		try {
			rendered = await mapConcurrent(
				chunks,
				systemResourcesService.getTrickplayConcurrency(),
				async (chunkTimeMs, spriteIndex) => await this.renderSprite(job, spriteIndex, chunkTimeMs, controller.signal),
				controller.signal,
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
			const written = await writeCoreArtifact({
				mediaFileId: job.mediaFileId,
				kind: "trickplay",
				contentType: CONTENT_TYPE_WEBP,
				content: sprite.file,
			});
			sprites.push({ url: written.url, tileCount: sprite.tileCount });
		}

		return sprites;
	}

	/** Decodes one grid of timestamps from the source into a single WebP sheet. */
	private async renderSprite(
		job: TrickplayJob,
		spriteIndex: number,
		chunkTimeMs: number[],
		signal: AbortSignal,
	): Promise<{ file: BunFile; tileCount: number }> {
		const { layout } = job;
		const spritePath = join(job.tempDir, `sprite_${spriteIndex}.webp`);
		const command = buildSpriteExtractionCommand(
			job.filePath,
			{
				mediaFileId: job.mediaFileId,
				timeMs: chunkTimeMs,
				width: layout.tileWidth,
				height: layout.tileHeight,
				columns: layout.columns,
				format: "webp",
			},
			spritePath,
		);
		const result = await ffMpegService.runToCompletion(command, {
			timeoutMs: FFMPEG_TIMEOUT_MS,
			maxOutputBytes: serverConfig.plugins.ffmpeg.maxOutputBytes,
			signal,
		});
		if (result.exitCode !== 0) {
			const exitText = result.exitCode === null ? "signal" : String(result.exitCode);
			throw new DomainError("internal", `Trickplay sprite extraction failed (exit ${exitText}): ${result.stderr}`, {
				code: "trickplay_extraction_failed",
			});
		}

		const spriteFile = file(spritePath);
		if (spriteFile.size === 0) throw new DomainError("internal", "Trickplay sprite is empty", { code: "trickplay_empty_sprite" });

		return { file: spriteFile, tileCount: chunkTimeMs.length };
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
