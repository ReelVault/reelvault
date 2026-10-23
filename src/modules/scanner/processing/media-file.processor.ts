import { basename } from "node:path";
import type { MediaIdentity } from "@reelvault/sdk/common";
import type { ExternalIdentifiers } from "@reelvault/sdk/plugin";
import { readSidecarMetadataHint, type SidecarMetadataHint } from "@/modules/metadata-sidecars/files/local-sidecar.reader";
import { recognizeWithPluginHooks } from "@/modules/recognition/recognition.service";
import type { RecognitionResult } from "@/modules/recognition/recognition.types";
import { episodeRangeTargets, extractPathProviderIds } from "@/modules/recognition/utils/recognition.utils";
import { type ChapterMarkerDraft, mapChaptersToMarkers } from "@/modules/scanner/probe/chapters-to-markers.utils";
import { mapMediaFileData } from "@/modules/scanner/probe/media-probe.mapper";
import { videoParser } from "@/modules/scanner/probe/video-parser.service";
import type {
	AdditionalEpisodeTarget,
	LibraryType,
	ProcessedMediaFile,
	ProcessedMediaFileWithMarkers,
	SkippedMediaFile,
} from "@/modules/scanner/scanner.types";
import { mediaRepository } from "@/repositories/media-files.repository";
import { CancellationError, throwIfAborted } from "@/utils/cancellation.utils";
import { DomainError, toDomainError } from "@/utils/domain.errors";
import { getFileStats } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { createInFlightCache } from "@/utils/memory.cache";
import { normalizePath } from "@/utils/path.utils";
import type { TaskSchedulingOptions } from "@/utils/task-context.types";

interface ProbeAndMapResult {
	tech: Awaited<ReturnType<typeof videoParser.probe>>;
	stats: Awaited<ReturnType<typeof getFileStats>>;
	mediaFileData: ReturnType<typeof mapMediaFileData> | null;
	markers?: ChapterMarkerDraft[] | undefined;
}

export interface ProcessRunOptions {
	signal?: AbortSignal | undefined;
	scheduling?: TaskSchedulingOptions | undefined;
	libraryId?: string | undefined;
}

/** Identity the scanner needs from a metadata match. */
export interface MetadataMatch {
	metadataId: string;
	movieId: string | null;
	episodeId: string | null;
}

export interface MetadataCheckInput {
	type: "movie" | "tv_show";
	parsed: MediaIdentity;
	sidecar?: SidecarMetadataHint | undefined;
	signal?: AbortSignal | undefined;
	scheduling?: TaskSchedulingOptions | undefined;
	libraryId?: string | undefined;
}

/**
 * Matches a recognised file against metadata providers. The application layer
 * implements it and the worker injects it, so the scanner never imports `application/`.
 */
export interface MetadataMatcher {
	checkMetadata(input: MetadataCheckInput): Promise<MetadataMatch | undefined>;
}

class MediaFileProcessor {
	readonly serviceName = "MediaFileProcessor";
	readonly logger = createLogger("MediaFileProcessor");

	private readonly metadataMatcher: MetadataMatcher;
	private readonly processingFiles = createInFlightCache<ProcessedMediaFileWithMarkers | SkippedMediaFile | null>();

	constructor(metadataMatcher: MetadataMatcher) {
		this.metadataMatcher = metadataMatcher;
	}

	/**
	 * Sidecar-first: NFO documents next to the video carry a trustworthy
	 * identity. Failure degrades to filename-parsed identity, never aborts.
	 */
	private async readSidecarHint(filePath: string, libraryType: LibraryType): Promise<SidecarMetadataHint | undefined> {
		// A name is set on purpose, so the ids it names win over the NFO's.
		const sidecar = await this.readNfoHint(filePath, libraryType);

		return withPathIdentifiers(sidecar, extractPathProviderIds(titlePathParts(filePath, libraryType)));
	}

	private async readNfoHint(filePath: string, libraryType: LibraryType): Promise<SidecarMetadataHint | undefined> {
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
		options: ProcessRunOptions = {},
	): Promise<ProcessedMediaFileWithMarkers | SkippedMediaFile | null> {
		return await this.processingFiles.getOrRun(filePath, () => this.processOnce(libraryType, filePath, skipExistingLookup, options));
	}

	/**
	 * Probe and file stats run concurrently for both single- and multi-episode
	 * files; failures degrade to `null` fields (probe failures are warned),
	 * never abort.
	 */
	private async probeAndMap(filePath: string, fileName: string, signal?: AbortSignal): Promise<ProbeAndMapResult> {
		const [technicalData, fileStats] = await Promise.allSettled([videoParser.probe(filePath, signal), getFileStats(filePath)]);

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

	/**
	 * Probes the file and applies the "never import without technical data" guard
	 * shared by the single- and multi-episode paths. A failed probe or a vanished
	 * file returns undefined; importing it would leave a row the scanner never
	 * revisits (size/mtime would match next time).
	 */
	private async probeOrSkip(filePath: string, fileName: string, signal?: AbortSignal): Promise<ProbeAndMapResult | undefined> {
		const probe = await this.probeAndMap(filePath, fileName, signal);
		throwIfAborted(signal);

		if (probe.tech && probe.stats) return probe;

		this.logger.warn("Failed to probe video — recording a scan finding and retrying on the next scan", { filePath });

		return undefined;
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
		options: ProcessRunOptions,
	): Promise<ProcessedMediaFileWithMarkers | SkippedMediaFile | null> {
		const { signal, scheduling } = options;
		try {
			throwIfAborted(signal);
			if (!filePath) {
				throw new DomainError("validation", "filePath is required", { code: "media_file.path_required" });
			}

			if (!skipExistingLookup) {
				const existingMediaFile = await mediaRepository.findIdByFilePath(filePath);
				if (existingMediaFile) return null;
			}

			const fileName = basename(filePath);
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
				this.probeOrSkip(filePath, fileName, signal),
				this.metadataMatcher.checkMetadata({
					type: recognition.type,
					parsed: recognition.identity,
					sidecar,
					signal,
					scheduling,
					libraryId: options.libraryId,
				}),
			]);
			throwIfAborted(signal);

			if (probeResult.status === "rejected") throw probeResult.reason;

			const probe = probeResult.value;
			if (!probe) return { skipReason: "probe_failed", fileName };

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
				probe,
			});
		} catch (error) {
			// Cancellation happens whenever a newer scan supersedes the running one —
			// expected, not a failure.
			if (error instanceof CancellationError) {
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
		const [sidecar, probe] = await Promise.all([
			this.readSidecarHint(filePath, recognition.type),
			this.probeOrSkip(filePath, fileName, signal),
		]);
		if (!probe) return { skipReason: "probe_failed", fileName };

		const targets: AdditionalEpisodeTarget[] = [];
		for (const episode of episodeTargets) {
			throwIfAborted(signal);
			try {
				const meta = await this.metadataMatcher.checkMetadata({
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

/** The folders and file name that name the title: the file and its folder for a movie, the show folder too for an episode. */
function titlePathParts(filePath: string, libraryType: LibraryType): readonly string[] {
	const parts = normalizePath(filePath).split("/").filter(Boolean);

	return parts.slice(libraryType === "movie" ? -2 : -3);
}

/** Adds the ids named in the path to the NFO hint, so both the local lookup and the provider lookup see them. */
function withPathIdentifiers(
	sidecar: SidecarMetadataHint | undefined,
	pathIdentifiers: ExternalIdentifiers,
): SidecarMetadataHint | undefined {
	if (Object.keys(pathIdentifiers).length === 0) return sidecar;

	return { ...sidecar, identifiers: { ...sidecar?.identifiers, ...pathIdentifiers } };
}

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

export function createMediaFileProcessor(metadataMatcher: MetadataMatcher): MediaFileProcessor {
	return new MediaFileProcessor(metadataMatcher);
}
