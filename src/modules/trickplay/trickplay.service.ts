import { file } from "bun";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { trickplayRepository } from "@/database/repositories/trickplay.repository";
import { QueryFields } from "@/database/utils/fields";
import { buildSpriteExtractionCommand } from "@/integrations/ffmpeg/ffmpeg.frame-extract";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { pluginArtifactsService } from "@/plugins/capabilities/plugin.artifacts";
import { serverConfig } from "@/server.config";
import { FFMPEG_TIMEOUT_MS } from "@/server.constants";
import { chunk } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
import { InternalError, NotFoundError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { clamp } from "@/utils/math.utils";
import { PathUtils } from "@/utils/path.utils";

/** Hard cap on extracted frames per file — a 3 h movie at a 10 s interval still fits (1080). */
const MAX_FRAMES_PER_FILE = 1200;

const CORE_TRICKPLAY_PLUGIN_ID = "core";
const CONTENT_TYPE_WEBP = "image/webp";
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

export interface TrickplayGenerationResult {
	mediaFileId: string;
	frames: number;
	sprites: number;
	skipped?: "disabled" | "no-duration";
}

/**
 * Built-in trickplay generator: extracts preview frames, tiles them into sprite
 * sheets and registers sprite + WebVTT artifacts (`kind: "trickplay"`,
 * `pluginId: "core"`). The artifact shape is exactly what the player's
 * trickplay hook parses (WebVTT cues with `<sprite url>#xywh=x,y,w,h` payloads),
 * which makes the external plugin `org.reelvault.trickplay` unnecessary.
 */
class TrickplayService extends BaseService {
	constructor() {
		super("TrickplayService");
	}

	async generateForMediaFile(mediaFileId: string): Promise<TrickplayGenerationResult> {
		if (!serverConfig.trickplay.enabled) {
			return { mediaFileId, frames: 0, sprites: 0, skipped: "disabled" };
		}

		const mediaFile = await mediaRepository.findByPrimaryId({
			primaryId: mediaFileId,
			fields: QueryFields.parse({ fields: "id,filePath,duration" }),
		});

		if (!mediaFile?.filePath)
			throw new NotFoundError(`Trickplay generation failed: media file '${mediaFileId}' not found`, { code: "media_file_not_found" });

		const durationSeconds = mediaFile.duration ?? 0;
		if (durationSeconds <= 0) return { mediaFileId, frames: 0, sprites: 0, skipped: "no-duration" };

		const intervalSeconds = Math.max(1, serverConfig.trickplay.intervalSeconds);
		const tileWidth = serverConfig.trickplay.tileWidth;
		const columns = serverConfig.trickplay.columns;
		const tileHeight = Math.round((tileWidth * 9) / 16 / 2) * 2;
		const tilesPerSprite = columns * columns;

		const frameCount = clamp(Math.floor(durationSeconds / intervalSeconds), 1, MAX_FRAMES_PER_FILE);
		const effectiveInterval = durationSeconds / frameCount;
		// Sample the middle of each interval — avoids black frames at scene starts.
		const timestampsMs = Array.from({ length: frameCount }, (_, index) =>
			Math.round(((index + 0.5) * durationSeconds * 1000) / frameCount),
		);

		const tempDir = PathUtils.join(serverConfig.paths.transcodeTmp, `trickplay_${mediaFileId}_${crypto.randomUUID()}`);
		await DirUtils.create(tempDir);

		try {
			const chunks = chunk(timestampsMs, tilesPerSprite);
			// xstack needs a full grid (and ≥2 inputs for its relative layout) — pad
			// the last chunk by repeating its final timestamp; unused tiles are never
			// referenced by the VTT.
			if (chunks.length > 0) {
				const lastChunk = chunks[chunks.length - 1];
				if (lastChunk && lastChunk.length > 0) {
					const padSource = lastChunk[lastChunk.length - 1];
					if (padSource !== undefined) {
						while (lastChunk.length < columns * columns) lastChunk.push(padSource);
					}
				}
			}

			const sprites: TrickplaySprite[] = [];

			// Idempotent regeneration: remove the PREVIOUS generation before writing
			// the new sprites. Deleting after the loop (as before) removed the
			// sprites we just wrote, leaving the VTT pointing at missing artifacts.
			await pluginArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, "trickplay", CORE_TRICKPLAY_PLUGIN_ID);

			try {
				for (const [spriteIndex, chunkTimeMs] of chunks.entries()) {
					const spritePath = PathUtils.join(tempDir, `sprite_${spriteIndex}.webp`);
					const command = buildSpriteExtractionCommand(
						mediaFile.filePath,
						{ mediaFileId, timeMs: chunkTimeMs, width: tileWidth, height: tileHeight, columns, format: "webp" },
						spritePath,
					);
					const result = await ffMpegService.runToCompletion(command, {
						timeoutMs: FFMPEG_TIMEOUT_MS,
						maxOutputBytes: serverConfig.plugins.ffmpeg.maxOutputBytes,
					});
					if (result.exitCode !== 0) {
						const exitText = result.exitCode === null ? "signal" : String(result.exitCode);
						throw new InternalError(`Trickplay sprite extraction failed (exit ${exitText}): ${result.stderr}`, {
							code: "trickplay_extraction_failed",
						});
					}

					const spriteFile = file(spritePath);
					const size = spriteFile.size;
					if (size === 0) throw new InternalError("Trickplay sprite is empty", { code: "trickplay_empty_sprite" });

					const content = new Uint8Array(await spriteFile.arrayBuffer());
					await FileUtils.delete(spritePath);

					const written = await pluginArtifactsService.write(CORE_TRICKPLAY_PLUGIN_ID, {
						mediaFileId,
						kind: "trickplay",
						contentType: CONTENT_TYPE_WEBP,
						content,
					});
					sprites.push({ url: written.url, tileCount: chunkTimeMs.length });
				}
			} catch (error) {
				// Remove partial sprites so a failed generation leaves no artifact
				// rows/files without their VTT behind.
				await pluginArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, "trickplay", CORE_TRICKPLAY_PLUGIN_ID).catch(() => {
					// best-effort cleanup
				});
				throw error;
			}

			// Cue timeline spans the whole duration; each cue points at its tile.
			const cues: TrickplayCue[] = [];
			for (let index = 0; index < frameCount; index++) {
				const spriteIndex = Math.floor(index / tilesPerSprite);
				const positionInSprite = index % tilesPerSprite;
				cues.push({
					startSeconds: index * effectiveInterval,
					endSeconds: Math.min((index + 1) * effectiveInterval, durationSeconds),
					x: (positionInSprite % columns) * tileWidth,
					y: Math.floor(positionInSprite / columns) * tileHeight,
					spriteUrl: sprites[spriteIndex]?.url ?? sprites[0]?.url ?? "",
				});
			}

			await pluginArtifactsService.write(CORE_TRICKPLAY_PLUGIN_ID, {
				mediaFileId,
				kind: "trickplay",
				contentType: CONTENT_TYPE_VTT,
				content: new TextEncoder().encode(buildTrickplayVtt(cues, tileWidth, tileHeight)),
			});

			this.logger.info("Trickplay generated", { mediaFileId, frames: frameCount, sprites: sprites.length });

			return { mediaFileId, frames: frameCount, sprites: sprites.length };
		} finally {
			await DirUtils.delete(tempDir);
		}
	}

	/** Media files that have no core-generated trickplay artifacts yet. */
	findMediaFileIdsMissingTrickplay(limit = 2000): Promise<string[]> {
		return trickplayRepository.findMediaFileIdsMissingTrickplay(limit);
	}

	stats(): Promise<{ total: number; withTrickplay: number; missingTrickplay: number }> {
		return trickplayRepository.stats();
	}
}

function vttTimestamp(seconds: number): string {
	const clamped = Math.max(0, seconds);
	const hours = Math.floor(clamped / 3600);
	const minutes = Math.floor((clamped % 3600) / 60);
	const secs = clamped % 60;

	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`;
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
