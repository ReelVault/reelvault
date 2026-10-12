import type { TrickplayRegenerationReport, TrickplayStats } from "@reelvault/sdk/common";
import { file } from "bun";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { type TrickplayRegenerationScope, trickplayRepository } from "@/database/repositories/trickplay.repository";
import { QueryFields } from "@/database/utils/fields";
import { buildSpriteExtractionCommand } from "@/integrations/ffmpeg/ffmpeg.frame-extract";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { CORE_ARTIFACTS_OWNER } from "@/modules/artifacts/artifacts.constants";
import { isStorageBudgetError, resolveCoreArtifactsBudgetBytes, writeCoreArtifact } from "@/modules/artifacts/artifacts-budget.utils";
import { mediaArtifactsService } from "@/modules/artifacts/media-artifacts.service";
import { summarizeRegenerationOutcomes } from "@/modules/trickplay/trickplay-regeneration.report";
import { serverConfig } from "@/server.config";
import { FFMPEG_TIMEOUT_MS } from "@/server.constants";
import { chunk } from "@/utils/array.utils";
import { DirUtils } from "@/utils/directory.utils";
import { DomainError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math.utils";
import { PathUtils } from "@/utils/path.utils";

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

		const mediaFile = await mediaRepository.findByPrimaryId({
			primaryId: mediaFileId,
			fields: QueryFields.parse({ fields: "id,filePath,duration" }),
		});

		if (!mediaFile?.filePath)
			throw new DomainError("not_found", `Trickplay generation failed: media file '${mediaFileId}' not found`, {
				code: "media_file_not_found",
			});

		const durationSeconds = mediaFile.duration ?? 0;
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

		const tempDir = PathUtils.join(serverConfig.paths.transcodeTmp, `trickplay_${mediaFileId}_${crypto.randomUUID()}`);
		if (!(await DirUtils.create(tempDir))) {
			// create() logs the underlying fs error and returns false — fail with the
			// actual cause instead of later reporting an empty sprite.
			throw new DomainError("internal", "Trickplay temp directory could not be created", { code: "trickplay_temp_dir_failed" });
		}

		const job: TrickplayJob = {
			mediaFileId,
			filePath: mediaFile.filePath,
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
			await mediaArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, "trickplay", CORE_ARTIFACTS_OWNER);

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
				await mediaArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, "trickplay", CORE_ARTIFACTS_OWNER).catch(() => {
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
			await DirUtils.delete(tempDir);
		}
	}

	/** Whether dropping this file's own artifacts would still leave core storage over budget. */
	private async exceedsArtifactBudget(mediaFileId: string): Promise<boolean> {
		const budgetBytes = await resolveCoreArtifactsBudgetBytes();
		const storedBytes = await mediaArtifactsService.getStoredBytes(CORE_ARTIFACTS_OWNER);
		const existingBytes = await mediaArtifactsService.getMediaFileStoredBytes(mediaFileId, CORE_ARTIFACTS_OWNER);
		if (storedBytes - existingBytes < budgetBytes) return false;

		this.logger.warn("Trickplay generation skipped: artifact storage budget exhausted", {
			mediaFileId,
			storedBytes,
			existingBytes,
			budgetBytes,
		});

		return true;
	}

	/** Renders each timestamp chunk into one WebP sprite sheet and stores it as a core trickplay artifact. */
	private async extractSprites(job: TrickplayJob, chunks: number[][]): Promise<TrickplaySprite[]> {
		const { layout } = job;
		const sprites: TrickplaySprite[] = [];
		for (const [spriteIndex, chunkTimeMs] of chunks.entries()) {
			const spritePath = PathUtils.join(job.tempDir, `sprite_${spriteIndex}.webp`);
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
			});
			if (result.exitCode !== 0) {
				const exitText = result.exitCode === null ? "signal" : String(result.exitCode);
				throw new DomainError("internal", `Trickplay sprite extraction failed (exit ${exitText}): ${result.stderr}`, {
					code: "trickplay_extraction_failed",
				});
			}

			const spriteFile = file(spritePath);
			if (spriteFile.size === 0) throw new DomainError("internal", "Trickplay sprite is empty", { code: "trickplay_empty_sprite" });

			// The artifact write streams the BunFile straight to its storage
			// path (no full buffer through JS) and deletes the temp source
			// afterwards — writeFileWithRollback owns that cleanup.
			const written = await writeCoreArtifact({
				mediaFileId: job.mediaFileId,
				kind: "trickplay",
				contentType: CONTENT_TYPE_WEBP,
				content: spriteFile,
			});
			sprites.push({ url: written.url, tileCount: chunkTimeMs.length });
		}

		return sprites;
	}

	/** Media files that have no core-generated trickplay artifacts yet. */
	findMediaFileIdsMissingTrickplay(limit = 2000): Promise<string[]> {
		return trickplayRepository.findMediaFileIdsMissingTrickplay(limit);
	}

	/** Media files of a regeneration scope, capped at `limit`; the caller reports how many matched beyond the cap. */
	findMediaFileIdsForRegeneration(scope: TrickplayRegenerationScope, force: boolean, limit: number): Promise<string[]> {
		return trickplayRepository.findMediaFileIdsForRegeneration(scope, force, limit);
	}

	countForRegeneration(scope: TrickplayRegenerationScope, force: boolean): Promise<number> {
		return trickplayRepository.countForRegeneration(scope, force);
	}

	/** Media files of several scopes, in scope order and capped at `limit` in total. */
	async findMediaFileIdsForRegenerations(scopes: readonly TrickplayRegenerationScope[], force: boolean, limit: number): Promise<string[]> {
		const ids: string[] = [];
		for (const scope of scopes) {
			if (ids.length >= limit) break;

			ids.push(...(await trickplayRepository.findMediaFileIdsForRegeneration(scope, force, limit - ids.length)));
		}

		return ids;
	}

	/** How many media files the scopes match in total, before the cap. */
	async countForRegenerations(scopes: readonly TrickplayRegenerationScope[], force: boolean): Promise<number> {
		const counts = await Promise.all(scopes.map((scope) => trickplayRepository.countForRegeneration(scope, force)));

		return counts.reduce((sum, count) => sum + count, 0);
	}

	/** Outcome counts of one regeneration operation, with the jobs the storage budget skipped on their own line. */
	async regenerationReport(operationId: string): Promise<TrickplayRegenerationReport> {
		return summarizeRegenerationOutcomes(operationId, await trickplayRepository.countRegenerationOutcomes(operationId));
	}

	/** Coverage counts plus the core artifact storage usage/budget for the admin page. */
	/**
	 * Removes the core trickplay previews of each media file. A file without previews, or an unknown id,
	 * counts as nothing removed rather than an error, so a bulk request can name files it did not check.
	 */
	async deletePreviews(
		mediaFileIds: readonly string[],
		options: { dryRun?: boolean | undefined } = {},
	): Promise<{ mediaFiles: number; artifacts: number }> {
		let mediaFiles = 0;
		let artifacts = 0;
		for (const mediaFileId of new Set(mediaFileIds)) {
			const deleted = options.dryRun
				? await mediaArtifactsService.countByMediaFileIdAndKind(mediaFileId, "trickplay", CORE_ARTIFACTS_OWNER)
				: await mediaArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, "trickplay", CORE_ARTIFACTS_OWNER);
			if (deleted > 0) {
				mediaFiles++;
				artifacts += deleted;
			}
		}

		if (!options.dryRun) trickplayRepository.clearStatsCache();

		return { mediaFiles, artifacts };
	}

	async stats(): Promise<TrickplayStats> {
		const [counts, storageBytes, storageBudgetBytes] = await Promise.all([
			trickplayRepository.stats(),
			mediaArtifactsService.getStoredBytes(CORE_ARTIFACTS_OWNER),
			resolveCoreArtifactsBudgetBytes(),
		]);

		return { ...counts, storageBytes, storageBudgetBytes };
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
