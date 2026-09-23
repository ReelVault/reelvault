import { MetadataProcess } from "@/application/catalog/metadata/metadata-process";
import { type TaskSchedulingOptions, toDomainError } from "@/application/context";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { readSidecarMetadataHint, type SidecarMetadataHint } from "@/modules/metadata-sidecars/files/local-sidecar-hint";
import { BaseService } from "@/utils/base-service";
import { ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { mapChaptersToMarkers } from "../probe/chapters-to-markers.utils";
import { mapMediaFileData } from "../probe/media-probe.mapper";
import { videoParser } from "../probe/video-parser.service";
import { recognizeWithPluginHooks } from "../recognition/recognition";
import type { LibraryType, ProcessedMediaFile, ProcessedMediaFileWithMarkers, SkippedMediaFile } from "../scanner.types";

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
	): Promise<ProcessedMediaFileWithMarkers | SkippedMediaFile | null> {
		const existingProcess = this.processingFiles.get(filePath);
		if (existingProcess) return await existingProcess;

		const processing = this.processOnce(libraryType, filePath, skipExistingLookup, signal, scheduling);
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

			const [technicalData, metadata, fileStats] = await Promise.allSettled([
				videoParser.probe(filePath, signal),
				this.metadataProcess.checkMetadata({
					type: recognition.type,
					parsed: recognition.identity,
					sidecar: await this.readSidecarHint(filePath, recognition.type),
					signal,
					scheduling,
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
			this.logger.error("Process file failed", error, { filePath });
			throw toDomainError(error, `Media file processing failed: ${filePath}`);
		}
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
