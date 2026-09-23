import type { MetadataStorageMode } from "@sdk/common/library.types";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { QueryFields } from "@/database/utils/fields";
import { systemResourcesService } from "@/system/system-resources.service";
import { isNotNullish } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { KeyedMutex } from "@/utils/mutex";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { type SidecarArtworkWriter, sidecarArtworkExporter } from "./saver/sidecar-artwork.exporter";
import type { SidecarFlavor, SidecarMetadataWriter } from "./sidecar.types";
import { type EpisodeRecord, episodeSnapshot, type SeasonRecord, seasonSnapshot } from "./sidecar-snapshot-resolver";
import { resolveMetadataStorageMode, resolveSeriesDirectory, usesSidecars } from "./sidecar-storage.utils";

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

function isEpisodeSaveTarget(target: SaveTarget): target is EpisodeSaveTarget {
	return target.episode !== undefined;
}

export class SidecarMetadataStorageService extends BaseService {
	private readonly writer: SidecarMetadataWriter;
	private readonly artwork: SidecarArtworkWriter;

	constructor(writer: SidecarMetadataWriter, artwork: SidecarArtworkWriter = sidecarArtworkExporter) {
		super("SidecarMetadataStorageService");
		this.writer = writer;
		this.artwork = artwork;
	}

	async saveLibraryMedia(library: SidecarStorageLibrary, mediaFiles: SidecarStorageMediaFile[]): Promise<void> {
		const flavor = library.sidecarFlavor ?? "reelvault";
		const savedSeries = new Set<string>();
		const savedSeasons = new Set<string>();
		const writes = new KeyedMutex();
		const episodeCache = new Map<string, Promise<EpisodeRecord | undefined>>();
		const seasonCache = new Map<string, Promise<SeasonRecord | undefined>>();

		const targets = await PromiseUtils.mapConcurrent(
			mediaFiles,
			systemResourcesService.getIoConcurrency(),
			async (mediaFile): Promise<SaveTarget | null> => {
				if (!usesSidecars(resolveMetadataStorageMode(library, mediaFile.filePath))) return null;

				if (mediaFile.movieId) return { mediaFile };

				if (!mediaFile.episodeId) return null;

				const episodePromise =
					episodeCache.get(mediaFile.episodeId) ??
					episodesRepository.findByPrimaryId({
						primaryId: mediaFile.episodeId,
						fields: QueryFields.parse({ fields: "id,seasonId,title,episodeNumber,airDate,overview,imageId" }),
					});
				episodeCache.set(mediaFile.episodeId, episodePromise);
				const episode = await episodePromise;
				// Concurrent catalog changes (library removal mid-scan) can delete the
				// episode/season rows under us — skip this file instead of failing the
				// whole sidecar batch.
				if (!episode) {
					this.logger.warn("Episode row missing — skipping sidecar save for media file", {
						mediaFilePath: mediaFile.filePath,
						episodeId: mediaFile.episodeId,
					});

					return null;
				}

				const seasonPromise =
					seasonCache.get(episode.seasonId) ??
					seasonsRepository.findByPrimaryId({
						primaryId: episode.seasonId,
						fields: QueryFields.parse({ fields: "id,seasonNumber,name,airDate,overview,status,imageId" }),
					});
				seasonCache.set(episode.seasonId, seasonPromise);
				const season = await seasonPromise;
				if (!season) {
					this.logger.warn("Season row missing — skipping sidecar save for media file", {
						mediaFilePath: mediaFile.filePath,
						episodeId: mediaFile.episodeId,
						seasonId: episode.seasonId,
					});

					return null;
				}

				return { mediaFile, episode, season };
			},
		);

		await PromiseUtils.mapConcurrent(
			targets.filter((item) => isNotNullish(item)),
			Math.max(1, Math.floor(systemResourcesService.getIoConcurrency() / 2)),
			async (target) => {
				const { mediaFile } = target;
				if (!isEpisodeSaveTarget(target)) {
					const movieDirectory = PathUtils.getDirName(mediaFile.filePath);
					await writes.runExclusive(`movie:${mediaFile.metadataId}:${movieDirectory}`, async () => {
						await this.writer.saveMovie({ metadataId: mediaFile.metadataId, movieDirectory, flavor });
						await this.artwork.saveTitleArtwork({ metadataId: mediaFile.metadataId, directory: movieDirectory });
					});

					return;
				}

				const { episode, season } = target;
				const episodeDirectory = PathUtils.getDirName(mediaFile.filePath);
				const seriesDirectory = resolveSeriesDirectory(library.paths, episodeDirectory);
				const seriesKey = `${mediaFile.metadataId}:${seriesDirectory}`;
				if (!savedSeries.has(seriesKey)) {
					savedSeries.add(seriesKey);
					await writes.runExclusive(`series:${seriesKey}`, async () => {
						await this.writer.saveSeries({ metadataId: mediaFile.metadataId, seriesDirectory, flavor });
						await this.artwork.saveTitleArtwork({ metadataId: mediaFile.metadataId, directory: seriesDirectory });
					});
				}

				const seasonKey = `${season.id}:${episodeDirectory}`;
				if (!savedSeasons.has(seasonKey)) {
					savedSeasons.add(seasonKey);
					await writes.runExclusive(`season:${seasonKey}`, () =>
						this.writer.saveSeason({
							seasonId: season.id,
							seasonDirectory: episodeDirectory,
							seasonNumber: season.seasonNumber,
							snapshot: seasonSnapshot(season),
							flavor,
						}),
					);
					await this.artwork.saveSeasonArtwork({
						imageId: season.imageId,
						directory: episodeDirectory,
						seasonNumber: season.seasonNumber,
					});
				}

				await writes.runExclusive(`episode:${episode.id}:${episodeDirectory}`, () =>
					this.writer.saveEpisode({
						episodeId: episode.id,
						episodeDirectory,
						videoBaseName: PathUtils.getFileNameWithoutExt(mediaFile.filePath),
						snapshot: episodeSnapshot(episode),
						flavor,
					}),
				);
				await this.artwork.saveEpisodeArtwork({
					imageId: episode.imageId,
					directory: episodeDirectory,
					videoBaseName: PathUtils.getFileNameWithoutExt(mediaFile.filePath),
				});
			},
		);
	}
}
