import { MetadataProcess } from "@/application/catalog/metadata/metadata-process";
import { type TaskSchedulingOptions, toDomainError } from "@/application/context";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { readSidecarMetadataHint, type SidecarMetadataHint } from "@/modules/metadata-sidecars/files/local-sidecar-hint";
import { BaseService } from "@/utils/base-service";
import { ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { InFlightMap } from "@/utils/in-flight-map";
import { PathUtils } from "@/utils/path.utils";
import { throwIfAborted, WorkerCancellationError } from "@/workers/utils/worker-cancellation";
import type { RecognitionResult } from "../../recognition/recognition.types";
import { episodeRangeTargets } from "../../recognition/utils/recognition.utils";
import { type ChapterMarkerDraft, mapChaptersToMarkers } from "../probe/chapters-to-markers.utils";
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

interface ProbeAndMapResult {
	tech: Awaited<ReturnType<typeof videoParser.probe>>;
	stats: Awaited<ReturnType<typeof FileUtils.getStats>>;
	mediaFileData: ReturnType<typeof mapMediaFileData> | null;
	markers?: ChapterMarkerDraft[] | undefined;
}

class MediaFileProcessor extends BaseService {
	private metadataProcessInstance: MetadataProcess | undefined;
	private readonly processingFiles = new InFlightMap<ProcessedMediaFileWithMarkers | SkippedMediaFile | null>();

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
		return await this.processingFiles.run(filePath, () =>
			this.processOnce(libraryType, filePath, skipExistingLookup, signal, scheduling, options),
		);
	}

	/**
	 * Probe and file stats run concurrently for both single- and multi-episode
	 * files; failures degrade to `null` fields (probe failures are warned),
	 * never abort.
	 */
	private async probeAndMap(filePath: string, fileName: string, signal?: AbortSignal): Promise<ProbeAndMapResult> {
		const [technicalData, fileStats] = await Promise.allSettled([videoParser.probe(filePath, signal), FileUtils.getStats(filePath)]);

		if (technicalData.status === "rejected") {
			this.logger.warn("Failed to probe video", { filePath, error: technicalData.reason });
		}

		const tech = technicalData.status === "fulfilled" ? technicalData.value : null;
		const stats = fileStats.status === "fulfilled" ? fileStats.value : null;
		const mediaFileData = tech ? mapMediaFileData(fileName, tech) : null;

		return {
			tech,
			stats,
			mediaFileData,
			...(tech ? { markers: mapChaptersToMarkers(tech.chapters ?? []) } : {}),
		};
	}

	/** Shared shape of a processed file — identity fields plus the probed technical data. */
	private buildProcessedMediaFile(params: {
		metadataId: string;
		movieId: string | null;
		episodeId: string | null;
		filePath: string;
		fileName: string;
		probe: ProbeAndMapResult;
		additionalTargets?: AdditionalEpisodeTarget[] | undefined;
	}): ProcessedMediaFileWithMarkers {
		const { metadataId, movieId, episodeId, filePath, fileName, probe, additionalTargets } = params;

		return {
			metadataId,
			movieId,
			episodeId,
			filePath,
			fileName,
			...(probe.mediaFileData ?? createEmptyMediaFileData()),
			...(probe.markers ? { automaticMarkers: probe.markers } : {}),
			isEnabled: true,
			size: probe.stats?.size ?? probe.mediaFileData?.size ?? null,
			sourceMtimeMs: probe.stats ? Math.floor(probe.stats.mtimeMs) : null,
			...(additionalTargets && additionalTargets.length > 0 ? { additionalTargets } : {}),
		};
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

			const sidecar = await this.readSidecarHint(filePath, recognition.type);
			const [probeResult, metadataResult] = await Promise.allSettled([
				this.probeAndMap(filePath, fileName, signal),
				this.metadataProcess.checkMetadata({
					type: recognition.type,
					parsed: recognition.identity,
					sidecar,
					signal,
					scheduling,
					libraryId: options?.libraryId,
				}),
			]);
			throwIfAborted(signal);

			if (probeResult.status === "rejected") throw probeResult.reason;

			if (metadataResult.status === "rejected") {
				this.logger.warn("Failed to check metadata", { filePath, error: metadataResult.reason });
			}

			const meta = metadataResult.status === "fulfilled" ? metadataResult.value : null;
			if (!meta?.metadataId) return { skipReason: "no_metadata_match", fileName };

			return this.buildProcessedMediaFile({
				metadataId: meta.metadataId,
				movieId: meta.movieId ?? null,
				episodeId: meta.episodeId ?? null,
				filePath,
				fileName,
				probe: probeResult.value,
			});
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
		const probe = await this.probeAndMap(filePath, fileName, signal);
		throwIfAborted(signal);

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

		return this.buildProcessedMediaFile({
			metadataId: first.metadataId,
			movieId: first.movieId,
			episodeId: first.episodeId,
			filePath,
			fileName,
			probe,
			additionalTargets: targets.slice(1),
		});
	}
}

type EmptyMediaFileData = Omit<
	ProcessedMediaFile,
	"metadataId" | "movieId" | "episodeId" | "filePath" | "fileName" | "isEnabled" | "size" | "sourceMtimeMs"
>;

function createEmptyMediaFileData(): EmptyMediaFileData {
	return {
		formatName: null,
		duration: null,
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
