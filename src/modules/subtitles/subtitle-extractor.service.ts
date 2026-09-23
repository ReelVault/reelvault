import { rename } from "node:fs/promises";
import { type BunFile, file } from "bun";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
import { createTempPath, FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { buildWebVttExtractionArgs, isBitmapSubtitleFormat } from "./extract/ffmpeg-args";

interface FfmpegRunResult {
	exitCode: number | null;
	stderr: string;
}

interface ServiceDependencies {
	runFfmpeg: (args: string[]) => Promise<FfmpegRunResult>;
	mediaFileExists: (path: string) => Promise<boolean>;
	subtitlesPath: () => string;
	getConcurrency: () => number;
}

const defaultDependencies: ServiceDependencies = {
	runFfmpeg: (args) => ffMpegService.runToCompletion(args, {}),
	mediaFileExists: (path) => file(path).exists(),
	subtitlesPath: () => serverConfig.paths.subtitles,
	getConcurrency: () => systemResourcesService.getHeavySubprocessConcurrency(),
};

export class SubtitleExtractorService extends BaseService {
	private readonly dependencies: ServiceDependencies;
	private readonly inFlightExtractions = new Map<string, Promise<{ contentType: string; file: Blob } | null>>();
	// Each extraction spawns an FFmpeg — concurrency derives from measured CPU capacity.
	private readonly extractionSemaphore = PromiseUtils.createSemaphore(() => this.dependencies.getConcurrency());

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("SubtitleExtractorService");
		this.dependencies = dependencies;
	}

	async extractToVtt(
		subtitleId: string,
		mediaFilePath: string,
		streamIndex: number | null | undefined,
		format?: string | null,
		signal?: AbortSignal,
	): Promise<{ contentType: string; file: Blob } | null> {
		throwIfAborted(signal);
		if (isBitmapSubtitleFormat(format)) {
			this.logger.warn("Bitmap subtitle extraction to WebVTT text track is not supported", { subtitleId, format });

			return null;
		}

		if (typeof streamIndex !== "number" || streamIndex < 0) {
			this.logger.warn("Invalid stream index for embedded subtitle extraction", { subtitleId, streamIndex });

			return null;
		}

		if (!(mediaFilePath && (await this.dependencies.mediaFileExists(mediaFilePath)))) {
			this.logger.warn("Media file does not exist for subtitle extraction", { subtitleId, mediaFilePath });

			return null;
		}

		const cacheFilePath = PathUtils.join(this.dependencies.subtitlesPath(), `${subtitleId}.vtt`);
		const cachedFile = file(cacheFilePath);

		if (await cachedFile.exists()) {
			return { contentType: "text/vtt", file: cachedFile };
		}

		const existingExtraction = this.inFlightExtractions.get(subtitleId);
		if (existingExtraction) {
			return await existingExtraction;
		}

		// The shared extraction runs on its own lifetime — an aborted requester must
		// not cancel ffmpeg out from under other clients waiting on the same track.
		// The result is cached on disk either way, so completing is always useful.
		const extractionPromise = this.extractionSemaphore.run(
			async () => await this.runExtraction(subtitleId, mediaFilePath, streamIndex, cacheFilePath),
		);
		this.inFlightExtractions.set(subtitleId, extractionPromise);

		try {
			return await extractionPromise;
		} finally {
			this.inFlightExtractions.delete(subtitleId);
		}
	}

	private async runExtraction(
		subtitleId: string,
		mediaFilePath: string,
		streamIndex: number,
		cacheFilePath: string,
	): Promise<{ contentType: "text/vtt"; file: BunFile } | null> {
		const tempFilePath = createTempPath(cacheFilePath, ".tmp");
		try {
			await DirUtils.create(this.dependencies.subtitlesPath());

			const result = await this.dependencies.runFfmpeg(buildWebVttExtractionArgs(mediaFilePath, streamIndex, tempFilePath));

			if (result.exitCode !== 0) {
				this.logger.error("FFmpeg failed to extract subtitle stream", new Error(result.stderr), {
					subtitleId,
					mediaFilePath,
					streamIndex,
					stderr: result.stderr,
				});

				return null;
			}

			const tempFile = file(tempFilePath);
			if (!(await tempFile.exists())) {
				this.logger.error("Extracted subtitle file was not created", undefined, { subtitleId, tempFilePath });

				return null;
			}

			// Atomic rename to target cache path
			await rename(tempFilePath, cacheFilePath);

			return { contentType: "text/vtt", file: file(cacheFilePath) };
		} catch (error) {
			this.logger.error("Error during subtitle extraction", error, { subtitleId, mediaFilePath, streamIndex });

			return null;
		} finally {
			// No-op after a successful rename; removes the temp file on any failure.
			await FileUtils.delete(tempFilePath).catch(() => {
				// Deletion is best-effort; the temp file may already be gone.
			});
		}
	}

	/** Resolves once an in-flight extraction for this subtitle settles (delete coordination). */
	async waitForInFlight(subtitleId: string): Promise<void> {
		await this.inFlightExtractions.get(subtitleId)?.catch(() => {
			// Settled extraction failures are surfaced through the original caller.
		});
	}
}

export const subtitleExtractorService = new SubtitleExtractorService();
