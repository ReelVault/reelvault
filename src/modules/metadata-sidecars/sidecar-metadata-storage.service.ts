import type { MetadataStorageMode } from "@reelvault/sdk/common";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { QueryFields } from "@/database/utils/fields";
import { systemResourcesService } from "@/system/system-resources.service";
import { isNotNullish, toMap, unique } from "@/utils/array.utils";
import { KeyedMutex } from "@/utils/concurrency";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { type SidecarArtworkWriter, sidecarArtworkExporter } from "./saver/sidecar-artwork.exporter";
import type { SidecarFlavor, SidecarMetadataWriter } from "./sidecar.types";
import { type EpisodeRecord, episodeSnapshot, type SeasonRecord, seasonSnapshot } from "./sidecar-snapshot-resolver";
import { prepareStorageRoots, resolveMetadataStorageMode, resolveSeriesDirectory, usesSidecars } from "./sidecar-storage.utils";

export interface SidecarStorageLibrary {
	metadataStorageMode: MetadataStorageMode;
	/** Target NFO dialect; libraries predate the field, so treat missing as the native flavor. */
	sidecarFlavor?: SidecarFlavor | null;
	paths: Array<{ path: string; metadataStorageMode: MetadataStorageMode | null }>;
}

export interface SidecarStorageMediaFile {
	filePath: string;
	metadataId: string;
	movieId: string | null;
	episodeId: string | null;
}

interface MovieSaveTarget {
	readonly mediaFile: SidecarStorageMediaFile;
	readonly episode?: undefined;
	readonly season?: undefined;
}

interface EpisodeSaveTarget {
	readonly mediaFile: SidecarStorageMediaFile;
	readonly episode: EpisodeRecord;
	readonly season: SeasonRecord;
}

type SaveTarget = MovieSaveTarget | EpisodeSaveTarget;

interface SeriesRows {
	episodesById: Map<string, EpisodeRecord>;
	seasonsById: Map<string, SeasonRecord>;
}

/** State shared by every target of one `saveLibraryMedia` run: write dedupe keys and per-key serialization. */
interface SaveScope {
	readonly flavor: SidecarFlavor;
	readonly storageRoots: ReturnType<typeof prepareStorageRoots>;
	readonly writes: KeyedMutex;
	readonly savedSeries: Set<string>;
	readonly savedSeasons: Set<string>;
}

function isEpisodeSaveTarget(target: SaveTarget): target is EpisodeSaveTarget {
	return target.episode !== undefined;
}

/**
 * Batch-resolve episodes and seasons for the whole batch: previously one
 * lookup per distinct id (a series sidecar sync paid one episode query per
 * episode). Chunked `findByIds` keeps the SQLite variable limit in check.
 */
async function loadSeriesRows(sidecarFiles: SidecarStorageMediaFile[]): Promise<SeriesRows> {
	const episodeIds = unique(sidecarFiles.map((mediaFile) => mediaFile.episodeId).filter((episodeId) => isNotNullish(episodeId)));
	const episodesById =
		episodeIds.length > 0
			? toMap(
					await episodesRepository.findRecordsByIds({
						ids: episodeIds,
						fields: QueryFields.parse({ fields: "id,seasonId,title,episodeNumber,airDate,overview,imageId" }),
					}),
					(episode) => episode.id,
				)
			: new Map<string, EpisodeRecord>();
	const seasonIds = unique([...episodesById.values()].map((episode) => episode.seasonId));
	const seasonsById =
		seasonIds.length > 0
			? toMap(
					await seasonsRepository.findByIds({
						ids: seasonIds,
						fields: QueryFields.parse({ fields: "id,seasonNumber,name,airDate,overview,status,imageId" }),
					}),
					(season) => season.id,
				)
			: new Map<string, SeasonRecord>();
	return { episodesById, seasonsById };
}

export class SidecarMetadataStorageService {
	readonly serviceName = "SidecarMetadataStorageService";
	readonly logger = createLogger("SidecarMetadataStorageService");

	private readonly writer: SidecarMetadataWriter;
	private readonly artwork: SidecarArtworkWriter;

	constructor(writer: SidecarMetadataWriter, artwork: SidecarArtworkWriter = sidecarArtworkExporter) {
		this.writer = writer;
		this.artwork = artwork;
	}

	async saveLibraryMedia(library: SidecarStorageLibrary, mediaFiles: SidecarStorageMediaFile[]): Promise<void> {
		const storageRoots = prepareStorageRoots(library);
		const sidecarFiles = mediaFiles.filter((mediaFile) =>
			usesSidecars(resolveMetadataStorageMode(library, mediaFile.filePath, storageRoots)),
		);
		if (sidecarFiles.length === 0) return;

		const rows = await loadSeriesRows(sidecarFiles);
		const targets = await PromiseUtils.mapConcurrent(sidecarFiles, systemResourcesService.getIoConcurrency(), (mediaFile) =>
			Promise.resolve(this.resolveSaveTarget(mediaFile, rows)),
		);

		const scope: SaveScope = {
			flavor: library.sidecarFlavor ?? "reelvault",
			storageRoots,
			writes: new KeyedMutex(),
			savedSeries: new Set<string>(),
			savedSeasons: new Set<string>(),
		};
		await PromiseUtils.mapConcurrent(
			targets.filter((item) => isNotNullish(item)),
			Math.max(1, Math.floor(systemResourcesService.getIoConcurrency() / 2)),
			(target) => (isEpisodeSaveTarget(target) ? this.saveEpisodeTarget(target, scope) : this.saveMovieTarget(target, scope)),
		);
	}

	private resolveSaveTarget(mediaFile: SidecarStorageMediaFile, rows: SeriesRows): SaveTarget | null {
		if (mediaFile.movieId) return { mediaFile };

		if (!mediaFile.episodeId) return null;

		// Concurrent catalog changes (library removal mid-scan) can delete the
		// episode/season rows under us — skip this file instead of failing the
		// whole sidecar batch.
		const episode = rows.episodesById.get(mediaFile.episodeId);
		if (!episode) {
			this.logger.warn("Episode row missing — skipping sidecar save for media file", {
				mediaFilePath: mediaFile.filePath,
				episodeId: mediaFile.episodeId,
			});

			return null;
		}

		const season = rows.seasonsById.get(episode.seasonId);
		if (!season) {
			this.logger.warn("Season row missing — skipping sidecar save for media file", {
				mediaFilePath: mediaFile.filePath,
				episodeId: mediaFile.episodeId,
				seasonId: episode.seasonId,
			});

			return null;
		}

		return { mediaFile, episode, season };
	}

	private async saveMovieTarget(target: MovieSaveTarget, scope: SaveScope): Promise<void> {
		const { mediaFile } = target;
		const movieDirectory = PathUtils.getDirName(mediaFile.filePath);
		await scope.writes.runExclusive(`movie:${mediaFile.metadataId}:${movieDirectory}`, async () => {
			await this.writer.saveMovie({ metadataId: mediaFile.metadataId, movieDirectory, flavor: scope.flavor });
			await this.artwork.saveTitleArtwork({ metadataId: mediaFile.metadataId, directory: movieDirectory });
		});
	}

	private async saveEpisodeTarget(target: EpisodeSaveTarget, scope: SaveScope): Promise<void> {
		const { mediaFile, episode, season } = target;
		const episodeDirectory = PathUtils.getDirName(mediaFile.filePath);
		const seriesDirectory = resolveSeriesDirectory(scope.storageRoots, episodeDirectory);
		await this.saveSeriesOnce(mediaFile, seriesDirectory, scope);
		await this.saveSeasonOnce(season, episodeDirectory, scope);

		await scope.writes.runExclusive(`episode:${episode.id}:${episodeDirectory}`, () =>
			this.writer.saveEpisode({
				episodeId: episode.id,
				episodeDirectory,
				videoBaseName: PathUtils.getFileNameWithoutExt(mediaFile.filePath),
				snapshot: episodeSnapshot(episode),
				flavor: scope.flavor,
			}),
		);
		await this.artwork.saveEpisodeArtwork({
			imageId: episode.imageId,
			directory: episodeDirectory,
			videoBaseName: PathUtils.getFileNameWithoutExt(mediaFile.filePath),
		});
	}

	private async saveSeriesOnce(mediaFile: SidecarStorageMediaFile, seriesDirectory: string, scope: SaveScope): Promise<void> {
		const seriesKey = `${mediaFile.metadataId}:${seriesDirectory}`;
		if (scope.savedSeries.has(seriesKey)) return;

		scope.savedSeries.add(seriesKey);
		await scope.writes.runExclusive(`series:${seriesKey}`, async () => {
			await this.writer.saveSeries({ metadataId: mediaFile.metadataId, seriesDirectory, flavor: scope.flavor });
			await this.artwork.saveTitleArtwork({ metadataId: mediaFile.metadataId, directory: seriesDirectory });
		});
	}

	private async saveSeasonOnce(season: SeasonRecord, episodeDirectory: string, scope: SaveScope): Promise<void> {
		const seasonKey = `${season.id}:${episodeDirectory}`;
		if (scope.savedSeasons.has(seasonKey)) return;

		scope.savedSeasons.add(seasonKey);
		await scope.writes.runExclusive(`season:${seasonKey}`, () =>
			this.writer.saveSeason({
				seasonId: season.id,
				seasonDirectory: episodeDirectory,
				seasonNumber: season.seasonNumber,
				snapshot: seasonSnapshot(season),
				flavor: scope.flavor,
			}),
		);
		await this.artwork.saveSeasonArtwork({
			imageId: season.imageId,
			directory: episodeDirectory,
			seasonNumber: season.seasonNumber,
		});
	}
}
