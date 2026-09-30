import { MetadataProcess } from "@/application/catalog/metadata/metadata-process";
import { type TaskSchedulingOptions, toDomainError } from "@/application/context";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { readSidecarMetadataHint, type SidecarMetadataHint } from "@/modules/metadata-sidecars/files/local-sidecar-hint";
import { BaseService } from "@/utils/base-service";
import { ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { throwIfAborted, WorkerCancellationError } from "@/workers/utils/worker-cancellation";
import type { RecognitionResult } from "../../recognition/recognition.types";
import { mapChaptersToMarkers } from "../probe/chapters-to-markers.utils";
import { mapMediaFileData } from "../probe/media-probe.mapper";
import { videoParser } from "../probe/video-parser.service";
import { recognizeWithPluginHooks } from "../recognition/recognition";
import type {
	AdditionalEpisodeTarget,
	LibraryType,
	ProcessedMediaFile,
	ProcessedMediaFileWithMarkers,
	SkippedMediaFile,
} from "../scanner.types";

/** Upper bound on episodes a single file may claim — longer "ranges" are scene noise. */
const MAX_EPISODE_RANGE_SPAN = 12;

/**
 * Episode numbers covered by the parsed identity: `[3]` for a plain SxxExx
 * file, `[3, 4, 5]` for S01E03-E05. `undefined` when the file is not a
 * multi-episode candidate (movies, single episodes, malformed ranges).
 */
function episodeRangeTargets(identity: RecognitionResult["identity"]): number[] | undefined {
	if (identity.type !== "episode" || identity.episode === undefined) return undefined;

	const start = identity.episode;
	const end = identity.episodeEnd ?? start;
	const span = end - start + 1;
	if (span <= 1) return undefined;
	if (span > MAX_EPISODE_RANGE_SPAN) return undefined;

	return Array.from({ length: span }, (_, index) => start + index);
}

class MediaFileProcessor extends BaseService {
	private metadataProcessInstance: MetadataProcess | undefined;
	private readonly processingFiles = new Map<string, Promise<ProcessedMediaFileWithMarkers | SkippedMediaFile | null>>();

	constructor() {
		super("MediaFileProcessor");
	}

	// Lazily constructed: `media-file-processor` sits in an import cycle with
	// `metadata-process` (via the worker graph). Eager construction at module
	// scope hits a TDZ on `MetadataProcess` when `metadata-process` is the
	// entrypoint — same failure mode documented for `AppLogger`.
	private get metadataProcess(): MetadataProcess {
		this.metadataProcessInstance ??= new MetadataProcess();

		return this.metadataProcessInstance;
	}

	/**
	 * Sidecar-first: NFO documents next to the video carry a trustworthy
	 * identity. Failure degrades to filename-parsed identity, never aborts.
	 */
	private async readSidecarHint(filePath: string, libraryType: LibraryType): Promise<SidecarMetadataHint | undefined> {
		try {
			return await readSidecarMetadataHint(filePath, libraryType);
		} catch (error) {
			this.logger.warn("Failed to read local sidecar identity — falling back to filename parsing", { filePath, error });
		}

		return undefined;
	}

	async process(
		libraryType: LibraryType,
		filePath: string,
		skipExistingLookup = false,
		signal?: AbortSignal,
		scheduling?: TaskSchedulingOptions,
		options?: { libraryId?: string | undefined },
	): Promise<ProcessedMediaFileWithMarkers | SkippedMediaFile | null> {
		const existingProcess = this.processingFiles.get(filePath);
		if (existingProcess) return await existingProcess;

		const processing = this.processOnce(libraryType, filePath, skipExistingLookup, signal, scheduling, options);
		this.processingFiles.set(filePath, processing);

		try {
			return await processing;
		} finally {
			this.processingFiles.delete(filePath);
		}
	}

	private async processOnce(
		libraryType: LibraryType,
		filePath: string,
		skipExistingLookup: boolean,
		signal?: AbortSignal,
		scheduling?: TaskSchedulingOptions,
		options?: { libraryId?: string | undefined },
	): Promise<ProcessedMediaFileWithMarkers | SkippedMediaFile | null> {
		try {
			throwIfAborted(signal);
			if (!filePath) {
				throw new ValidationError("filePath is required");
			}

			if (!skipExistingLookup) {
				const existingMediaFile = await mediaRepository.findIdByFilePath(filePath);
				if (existingMediaFile) return null;
			}

			const fileName = PathUtils.getFileName(filePath);
			const recognition = await recognizeWithPluginHooks(filePath);
			throwIfAborted(signal);
			if (!recognition) {
				this.logger.warn("Unknown file structure", { fileName });

				return { skipReason: "recognition_failed", fileName };
			}

			if (recognition.type !== libraryType) {
				this.logger.warn("File type mismatch", {
					filePath,
					expected: libraryType,
					actual: recognition.type,
				});

				return { skipReason: "type_mismatch", fileName };
			}

			const episodeTargets = episodeRangeTargets(recognition.identity);
			if (episodeTargets !== undefined)
				return await this.processMultiEpisodeFile({
					filePath,
					fileName,
					recognition,
					episodeTargets,
					signal,
					scheduling,
					options,
				});

			const [technicalData, metadata, fileStats] = await Promise.allSettled([
				videoParser.probe(filePath, signal),
				this.metadataProcess.checkMetadata({
					type: recognition.type,
					parsed: recognition.identity,
					sidecar: await this.readSidecarHint(filePath, recognition.type),
					signal,
					scheduling,
					libraryId: options?.libraryId,
				}),
				FileUtils.getStats(filePath),
			]);
			throwIfAborted(signal);

			const tech = technicalData.status === "fulfilled" ? technicalData.value : null;
			const meta = metadata.status === "fulfilled" ? metadata.value : null;
			const stats = fileStats.status === "fulfilled" ? fileStats.value : null;
			const mediaFileData = tech ? mapMediaFileData(fileName, tech) : null;

			if (technicalData.status === "rejected") {
				this.logger.warn("Failed to probe video", { filePath, error: technicalData.reason });
			}

			if (metadata.status === "rejected") {
				this.logger.warn("Failed to check metadata", { filePath, error: metadata.reason });
			}

			if (!meta?.metadataId) return { skipReason: "no_metadata_match", fileName };

			return {
				metadataId: meta.metadataId,
				movieId: meta.movieId ?? null,
				episodeId: meta.episodeId ?? null,
				filePath,
				fileName,
				...(mediaFileData ?? createEmptyMediaFileData()),
				...(tech ? { automaticMarkers: mapChaptersToMarkers(tech.chapters ?? []) } : {}),
				isEnabled: true,
				size: stats?.size ?? mediaFileData?.size ?? null,
				sourceMtimeMs: stats ? Math.floor(stats.mtimeMs) : null,
			};
		} catch (error) {
			// Cancellation happens whenever a newer scan supersedes the running one —
			// expected, not a failure.
			if (error instanceof WorkerCancellationError) {
				this.logger.warn("Process file cancelled", { filePath });
				throw error;
			}

			this.logger.error("Process file failed", error, { filePath });
			throw toDomainError(error, `Media file processing failed: ${filePath}`);
		}
	}

	/**
	 * A file covering several episodes (S01E01-E02) resolves metadata for every
	 * covered episode — sequentially, since the first call creates the show and
	 * season rows the rest reuse. Probe and file stats run once for the whole
	 * file; only the identity differs per episode.
	 */
	private async processMultiEpisodeFile({
		filePath,
		fileName,
		recognition,
		episodeTargets,
		signal,
		scheduling,
		options,
	}: {
		filePath: string;
		fileName: string;
		recognition: RecognitionResult;
		episodeTargets: number[];
		signal?: AbortSignal | undefined;
		scheduling?: TaskSchedulingOptions | undefined;
		options?: { libraryId?: string | undefined } | undefined;
	}): Promise<ProcessedMediaFileWithMarkers | SkippedMediaFile | null> {
		const sidecar = await this.readSidecarHint(filePath, recognition.type);
		const [technicalData, fileStats] = await Promise.allSettled([videoParser.probe(filePath, signal), FileUtils.getStats(filePath)]);
		throwIfAborted(signal);

		if (technicalData.status === "rejected") {
			this.logger.warn("Failed to probe video", { filePath, error: technicalData.reason });
		}

		const tech = technicalData.status === "fulfilled" ? technicalData.value : null;
		const stats = fileStats.status === "fulfilled" ? fileStats.value : null;
		const mediaFileData = tech ? mapMediaFileData(fileName, tech) : null;

		const targets: AdditionalEpisodeTarget[] = [];
		for (const episode of episodeTargets) {
			throwIfAborted(signal);
			try {
				const meta = await this.metadataProcess.checkMetadata({
					type: recognition.type,
					parsed: { ...recognition.identity, episode, episodeEnd: undefined },
					sidecar,
					signal,
					scheduling,
					libraryId: options?.libraryId,
				});
				if (meta?.episodeId) {
					targets.push({ metadataId: meta.metadataId, movieId: meta.movieId ?? null, episodeId: meta.episodeId });
				}
			} catch (error) {
				// One failed episode must not sink the others — the row count stays
				// below the file's span, so the next scan re-ingests and retries it.
				this.logger.warn("Multi-episode metadata resolution failed", { filePath, episode, error: String(error) });
			}
		}

		const first = targets[0];
		if (!first) return { skipReason: "no_metadata_match", fileName };

		const rest = targets.slice(1);

		return {
			metadataId: first.metadataId,
			movieId: first.movieId,
			episodeId: first.episodeId,
			filePath,
			fileName,
			...(mediaFileData ?? createEmptyMediaFileData()),
			...(tech ? { automaticMarkers: mapChaptersToMarkers(tech.chapters ?? []) } : {}),
			isEnabled: true,
			size: stats?.size ?? mediaFileData?.size ?? null,
			sourceMtimeMs: stats ? Math.floor(stats.mtimeMs) : null,
			...(rest.length > 0 ? { additionalTargets: rest } : {}),
		};
	}
}

function createEmptyMediaFileData(): Omit<ProcessedMediaFile, "metadataId" | "movieId" | "episodeId" | "filePath" | "fileName"> {
	return {
		formatName: null,
		duration: null,
		size: null,
		sourceMtimeMs: null,
		isEnabled: true,
		bitRate: null,
		videoStreams: [],
		audioStreams: [],
		subtitles: [],
		source: null,
		edition: null,
		qualityTag: null,
	};
}

export const mediaFileProcessor = new MediaFileProcessor();
