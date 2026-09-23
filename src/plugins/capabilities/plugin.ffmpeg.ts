import type {
	ExtractedFrame,
	ExtractedSprite,
	FrameExtractionRequest,
	FrameImageFormat,
	SpriteExtractionRequest,
} from "@reelvault/sdk/plugin";
import { file } from "bun";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { QueryFields } from "@/database/utils/fields";
import { getEffectiveHwaccel, hardwareDecodeArgs } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import {
	buildFrameExtractionCommand,
	buildSingleFrameExtractionCommand,
	buildSpriteTileCommand,
} from "@/integrations/ffmpeg/ffmpeg.frame-extract";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { serverConfig } from "@/server.config";
import { FFMPEG_TIMEOUT_MS } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
import { InternalError, NotFoundError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { clamp } from "@/utils/math.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { hardenAnalyseArgs, processFailureDetail } from "./ffmpeg/analyse-args.hardener";
import { assertFrameExtractionRequest, assertSpriteExtractionRequest, contentTypeFor } from "./ffmpeg/request-validation";

class PluginFfmpegService extends BaseService {
	/**
	 * Plugin-triggered ffmpeg analyses share the machine with playback transcoding —
	 * a batch plugin must not be able to spawn an unbounded number of ffmpeg
	 * processes, so concurrent runAnalyse calls wait on this semaphore.
	 */
	private readonly analyseSemaphore = PromiseUtils.createSemaphore(() =>
		clamp(Math.ceil(systemResourcesService.getMetrics().capacity / 2), 1, 4),
	);

	constructor() {
		super("PluginFfmpegService");
	}

	/**
	 * Generic ffmpeg run for analysis-type jobs (loudnorm passes, scene detection…).
	 * Args are passed file-level (spawn array, no shell); plugins never see stdout
	 * — they get the exit code and the stderr tail they need to parse results from.
	 *
	 * Hardening: network protocols are stripped (no SSRF via `-i http://…`), the
	 * raw-copy `data` muxer is rejected (no arbitrary file reads), and the final
	 * output path must stay inside server-managed directories. Inputs elsewhere on
	 * disk are allowed — plugins with `media:read` already receive `filePath`.
	 */
	async runAnalyse(
		args: string[],
		options?: {
			timeoutMs?: number | undefined;
			captureStdout?: boolean | undefined;
			maxStdoutBytes?: number | undefined;
			useHardwareDecode?: boolean | undefined;
		},
	): Promise<{ exitCode: number; stderr: string; stdout?: Uint8Array }> {
		const timeoutMs = clamp(options?.timeoutMs ?? FFMPEG_TIMEOUT_MS, 1_000, FFMPEG_TIMEOUT_MS);
		const safeArgs = hardenAnalyseArgs(args, options?.useHardwareDecode === true);

		return await this.analyseSemaphore.run(async () => {
			const result = await ffMpegService.runToCompletion(safeArgs, {
				timeoutMs,
				stdout: options?.captureStdout ? "pipe" : "ignore",
				maxOutputBytes: options?.maxStdoutBytes,
			});

			return {
				exitCode: result.exitCode ?? -1,
				stderr: result.stderr,
				...(options?.captureStdout ? { stdout: result.stdout } : {}),
			};
		});
	}

	async extractFrame(request: FrameExtractionRequest): Promise<ExtractedFrame> {
		assertFrameExtractionRequest(request);
		const mediaFile = await this.requireMediaFile(request.mediaFileId);

		const tempDir = serverConfig.paths.transcodeTmp;
		await DirUtils.create(tempDir);
		const format = request.format ?? "webp";
		const tempFilePath = PathUtils.join(tempDir, `frame_${crypto.randomUUID()}.${format}`);
		const hwDecodeArgs = hardwareDecodeArgs(getEffectiveHwaccel());

		try {
			const content = await this.runFfmpeg(
				buildFrameExtractionCommand(mediaFile.filePath, request, tempFilePath, hwDecodeArgs),
				request.mediaFileId,
				"frame",
				tempFilePath,
				hwDecodeArgs.length > 0 ? buildFrameExtractionCommand(mediaFile.filePath, request, tempFilePath) : undefined,
			);

			return { content, contentType: contentTypeFor(format) };
		} catch (error) {
			await FileUtils.delete(tempFilePath);
			throw error;
		}
	}

	async extractSprite(request: SpriteExtractionRequest): Promise<ExtractedSprite> {
		assertSpriteExtractionRequest(request);
		const mediaFile = await this.requireMediaFile(request.mediaFileId);

		const { framesDir, spriteOutputPath, format, ext, hwDecodeArgs } = await this.prepareSpriteEnvironment(request);

		try {
			await this.extractSpriteFrames(mediaFile.filePath, request, framesDir, ext, hwDecodeArgs);
			const { columns, rows } = await this.assembleSpriteTile(framesDir, request, ext, format, spriteOutputPath);

			return await this.readSpriteOutput(spriteOutputPath, format, request, columns, rows);
		} catch (error) {
			await FileUtils.delete(spriteOutputPath);
			throw error;
		} finally {
			await DirUtils.deleteTemporary(framesDir);
		}
	}

	private async prepareSpriteEnvironment(request: SpriteExtractionRequest) {
		const tempBaseDir = serverConfig.paths.transcodeTmp;
		await DirUtils.create(tempBaseDir);

		const buildId = crypto.randomUUID();
		const framesDir = PathUtils.join(tempBaseDir, `sprite_frames_${buildId}`);
		await DirUtils.create(framesDir);

		const format = request.format ?? "webp";
		const ext = format === "webp" ? "webp" : "jpg";
		const spriteOutputPath = PathUtils.join(tempBaseDir, `sprite_${buildId}.${ext}`);
		const hwaccel = getEffectiveHwaccel();
		const hwDecodeArgs = hardwareDecodeArgs(hwaccel);
		if (hwDecodeArgs.length > 0) {
			this.logger.debug("Extracting sprite frames with hardware decode", {
				mediaFileId: request.mediaFileId,
				frames: request.timeMs.length,
				hwaccel: hwaccel.type,
			});
		}

		return { framesDir, spriteOutputPath, format, ext, hwDecodeArgs };
	}

	private async extractSpriteFrames(
		filePath: string,
		request: SpriteExtractionRequest,
		framesDir: string,
		ext: string,
		hwDecodeArgs: string[],
	): Promise<void> {
		await PromiseUtils.mapConcurrent(request.timeMs, systemResourcesService.getHeavySubprocessConcurrency(), async (timeMs, index) => {
			const paddedIndex = String(index).padStart(4, "0");
			const framePath = PathUtils.join(framesDir, `frame_${paddedIndex}.${ext}`);
			const frameCmd = buildSingleFrameExtractionCommand(
				filePath,
				timeMs,
				request.width,
				request.height,
				request.format ?? "webp",
				framePath,
				hwDecodeArgs,
			);
			let result = await ffMpegService.runToCompletion(frameCmd, {
				timeoutMs: FFMPEG_TIMEOUT_MS,
				maxOutputBytes: serverConfig.plugins.ffmpeg.maxOutputBytes,
			});
			if (result.exitCode !== 0 && hwDecodeArgs.length > 0) {
				this.logger.warn("HW decode failed for sprite frame — retrying with software decode", {
					mediaFileId: request.mediaFileId,
					timeMs,
					exitCode: result.exitCode,
				});
				result = await ffMpegService.runToCompletion(
					buildSingleFrameExtractionCommand(filePath, timeMs, request.width, request.height, request.format ?? "webp", framePath),
					{ timeoutMs: FFMPEG_TIMEOUT_MS, maxOutputBytes: serverConfig.plugins.ffmpeg.maxOutputBytes },
				);
			}

			if (result.exitCode !== 0) {
				this.logger.error(
					"FFmpeg frame extraction failed during sprite build",
					new Error(processFailureDetail(result.stderr, result.exitCode, "FFmpeg process")),
					{ mediaFileId: request.mediaFileId, timeMs, exitCode: result.exitCode },
				);
				throw new InternalError("FFmpeg sprite extraction failed", { code: "plugin.ffmpeg.process_failed" });
			}
		});
	}

	private async assembleSpriteTile(
		framesDir: string,
		request: SpriteExtractionRequest,
		ext: string,
		format: FrameImageFormat,
		spriteOutputPath: string,
	): Promise<{ columns: number; rows: number }> {
		const columns = Math.min(request.columns, request.timeMs.length);
		const rows = Math.ceil(request.timeMs.length / columns);
		const framesPattern = PathUtils.join(framesDir, `frame_%04d.${ext}`);
		const tileCmd = buildSpriteTileCommand(framesPattern, columns, rows, format, spriteOutputPath);

		const { exitCode: tileExitCode, stderr: tileStderr } = await ffMpegService.runToCompletion(tileCmd, {
			timeoutMs: FFMPEG_TIMEOUT_MS,
			maxOutputBytes: serverConfig.plugins.ffmpeg.maxOutputBytes,
		});
		if (tileExitCode !== 0) {
			this.logger.error("FFmpeg sprite tile failed", new Error(processFailureDetail(tileStderr, tileExitCode, "FFmpeg tile process")), {
				mediaFileId: request.mediaFileId,
				exitCode: tileExitCode,
			});
			throw new InternalError("FFmpeg sprite extraction failed", { code: "plugin.ffmpeg.process_failed" });
		}

		return { columns, rows };
	}

	private async readSpriteOutput(
		spriteOutputPath: string,
		format: FrameImageFormat,
		request: SpriteExtractionRequest,
		columns: number,
		rows: number,
	): Promise<ExtractedSprite> {
		const spriteFile = file(spriteOutputPath);
		const size = spriteFile.size;
		if (size === 0 || size > serverConfig.plugins.ffmpeg.maxOutputBytes) {
			await FileUtils.delete(spriteOutputPath);
			throw new InternalError("FFmpeg returned an invalid sprite size", { code: "plugin.ffmpeg.invalid_output" });
		}

		const content = new Uint8Array(await spriteFile.arrayBuffer());
		await FileUtils.delete(spriteOutputPath);

		return {
			content,
			contentType: contentTypeFor(format),
			frameWidth: request.width,
			frameHeight: request.height,
			columns,
			rows,
		};
	}

	private async requireMediaFile(mediaFileId: string) {
		const mediaFile = await mediaRepository.findByPrimaryId({
			primaryId: mediaFileId,
			fields: QueryFields.parse({ fields: "id,filePath" }),
		});
		if (!(mediaFile && (await FileUtils.exists(mediaFile.filePath)))) {
			throw new NotFoundError(`Media file ${mediaFileId} is unavailable`, { code: "plugin.ffmpeg.media_not_found" });
		}

		return mediaFile;
	}

	/**
	 * Runs an ffmpeg command to completion and returns its output file, validated to be a
	 * non-empty image within size limits. When `softwareFallbackArgs` is provided and the
	 * first run fails, it is retried once with those args (software decode).
	 */
	private async runFfmpeg(
		args: string[],
		mediaFileId: string,
		label: "frame" | "sprite",
		tempFilePath: string,
		softwareFallbackArgs?: string[],
	): Promise<Uint8Array> {
		let { exitCode, stderr } = await ffMpegService.runToCompletion(args, {
			timeoutMs: FFMPEG_TIMEOUT_MS,
			maxOutputBytes: serverConfig.plugins.ffmpeg.maxOutputBytes,
		});
		if (exitCode !== 0 && softwareFallbackArgs) {
			this.logger.warn("HW decode failed — retrying frame extraction with software decode", { mediaFileId, exitCode });
			({ exitCode, stderr } = await ffMpegService.runToCompletion(softwareFallbackArgs, {
				timeoutMs: FFMPEG_TIMEOUT_MS,
				maxOutputBytes: serverConfig.plugins.ffmpeg.maxOutputBytes,
			}));
		}

		if (exitCode !== 0) {
			await FileUtils.delete(tempFilePath);
			// A null exitCode means the process was killed by a signal — surface it as -1.
			const exitCodeValue: number = exitCode ?? -1;
			this.logger.error(
				`FFmpeg ${label} extraction failed`,
				new Error(typeof stderr === "string" ? stderr : `FFmpeg process exited with code ${exitCodeValue}`),
				{
					mediaFileId,
					exitCode,
				},
			);
			throw new InternalError(`FFmpeg ${label} extraction failed`, { code: "plugin.ffmpeg.process_failed" });
		}

		const tempFile = file(tempFilePath);
		const size = tempFile.size;
		if (size === 0 || size > serverConfig.plugins.ffmpeg.maxOutputBytes) {
			await FileUtils.delete(tempFilePath);
			throw new InternalError(`FFmpeg returned an invalid ${label} size`, { code: "plugin.ffmpeg.invalid_output" });
		}

		// Read the (size-bounded) result into memory so the temp file can be
		// removed before returning — callers get a self-contained payload and
		// nothing leaks into the transcode temp dir.
		const bytes = new Uint8Array(await tempFile.arrayBuffer());
		await FileUtils.delete(tempFilePath);

		return bytes;
	}
}

export const pluginFfmpegService = new PluginFfmpegService();
