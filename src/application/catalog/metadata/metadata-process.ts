import type { MediaIdentity } from "@sdk/common/media";
import type { ProviderEpisodeResult, ProviderMetadataResult, ProviderSeasonResult } from "@sdk/plugin";
import type { TaskSchedulingOptions } from "@/application/context";
import { notificationsService } from "@/application/notifications/notifications.service";
import { pluginsService } from "@/application/plugins.service";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { metadataPersistenceRepository } from "@/database/repositories/metadata-persistence.repository";
import { moviesRepository } from "@/database/repositories/movies.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import type { SidecarMetadataHint } from "@/modules/metadata-sidecars/files/local-sidecar-hint";
import type { AggregatedProviderLink } from "@/plugins/capabilities/metadata-aggregator";
import { serverConfig } from "@/server.config";
import { toMap } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { PromiseUtils } from "@/utils/promise.utils";
import { enqueueImageProcessing, type ImageProcessingData } from "@/workers/definitions/images/image-processing.worker";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { applyMetadataCandidate, toMetadataCandidate } from "./metadata-normalization";

type EnqueueImages = (data: ImageProcessingData, options?: TaskSchedulingOptions) => Promise<unknown>;

/** Deterministic slug for sidecar-derived external ids / genre ids. */
function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}
interface BaseMetadataProcess {
	metadataId: string;
	metadata: ProviderMetadataResult;
	metadataStableKey: string | null;
	created: boolean;
	personImages: Array<{ personId: string; url: string }>;
}
interface MetadataProcessResult {
	metadataId: string;
	movieId: string | null;
	episodeId: string | null;
}

const enqueueImagesInBackground = (data: ImageProcessingData, options: TaskSchedulingOptions = {}): Promise<unknown> =>
	enqueueImageProcessing(data, options);

export class MetadataProcess extends BaseService {
	private readonly baseMetadataProcesses = new Map<string, Promise<BaseMetadataProcess>>();
	private readonly imageEnqueueProcesses = new Map<string, Promise<void>>();
	private readonly enqueueImages: EnqueueImages;

	constructor(enqueueImages: EnqueueImages = enqueueImagesInBackground) {
		super("MetadataProcess");
		this.enqueueImages = enqueueImages;
	}

	async checkMetadata({
		type,
		parsed,
		sidecar,
		signal,
		scheduling,
	}: {
		type: "movie" | "tv_show";
		parsed: MediaIdentity;
		sidecar?: SidecarMetadataHint | undefined;
		signal?: AbortSignal | undefined;
		scheduling?: TaskSchedulingOptions | undefined;
	}): Promise<
		| {
				metadataId: string;
				movieId: string | null;
				episodeId: string | null;
		  }
		| undefined
	> {
		try {
			throwIfAborted(signal);

			// 0. Sidecar-first: a local NFO carrying imdb/tmdb ids pins the title
			// without any provider round-trip — works fully offline.
			const sidecarMatch = sidecar ? await this.findMetadataByIdentifiers(type, sidecar) : undefined;
			if (sidecarMatch) {
				if (type === "movie") {
					return await this.processMovieMetadata(sidecarMatch.metadataId, sidecarMatch.stableKey);
				}

				const tvShow = await this.processTVShowMetadata(
					sidecarMatch.metadataId,
					parsed,
					sidecarMatch.metadata,
					sidecarMatch.stableKey,
					scheduling,
					sidecarMatch.providers,
					sidecar,
				);
				if (tvShow) return tvShow;
			}

			// 1. Check the local database first — the metadata may already exist.
			// The NFO title/year (when present) beat the filename parse.
			const enrichedParsed: MediaIdentity = { ...parsed, title: sidecar?.title ?? parsed.title, year: sidecar?.year ?? parsed.year };
			const existingLocal = await this.findExistingLocalMetadata(type, enrichedParsed);
			if (existingLocal) {
				if (type === "movie") {
					const movie = await this.processMovieMetadata(existingLocal.id, existingLocal.stableKey);

					return movie;
				}

				const tvShow = await this.resolveLocalTVShow(existingLocal, parsed, scheduling);
				if (tvShow) return tvShow;
			}

			// 2. If not found locally, search metadata providers (e.g. TMDB) and merge the results
			const aggregated = await pluginsService.fetchProviderDetailsAggregated(type, enrichedParsed);
			throwIfAborted(signal);

			if (!aggregated) {
				// 3. Sidecar offline import: no local row, no provider hit — build the
				// metadata row from the NFO itself so an offline server still imports.
				const fromSidecar = sidecar?.title ? await this.createSidecarMetadata(type, sidecar) : undefined;
				if (!fromSidecar) {
					this.logger.debug("No metadata match found", { title: enrichedParsed.title, year: enrichedParsed.year, type });

					return undefined;
				}

				if (type === "movie") {
					const movie = await this.processMovieMetadata(fromSidecar.base.metadataId, fromSidecar.base.metadataStableKey);
					if (movie) await this.enqueueBaseMetadataImages(fromSidecar.base, scheduling);

					return movie;
				}

				const tvShow = await this.processTVShowMetadata(
					fromSidecar.base.metadataId,
					parsed,
					fromSidecar.base.metadata,
					fromSidecar.base.metadataStableKey,
					scheduling,
					fromSidecar.providers,
					sidecar,
				);
				if (tvShow) await this.enqueueBaseMetadataImages(fromSidecar.base, scheduling);

				return tvShow;
			}

			const baseMetadata = await this.ensureBaseMetadata(
				type,
				aggregated.primaryProviderId,
				aggregated.metadata,
				aggregated.matchScore,
				aggregated.providers,
			);

			if (type === "movie") {
				const movie = await this.processMovieMetadata(baseMetadata.metadataId, baseMetadata.metadataStableKey);
				if (movie) await this.enqueueBaseMetadataImages(baseMetadata, scheduling);

				return movie;
			}

			const tvShow = await this.processTVShowMetadata(
				baseMetadata.metadataId,
				parsed,
				baseMetadata.metadata,
				baseMetadata.metadataStableKey,
				scheduling,
				aggregated.providers,
			);
			if (tvShow) await this.enqueueBaseMetadataImages(baseMetadata, scheduling);

			return tvShow;
		} catch (error) {
			this.logger.error("Check metadata failed", error, { type, parsed });
			throw error;
		}
	}

	private async findExistingLocalMetadata(
		type: "movie" | "tv_show",
		parsed: MediaIdentity,
	): Promise<Awaited<ReturnType<typeof metadataRepository.findByTitleAndType>> | undefined> {
		try {
			// Existence probe run once per media file during scans — project the
			// four consumed columns or the default fetch fans out into the full
			// detail-page relation load per file.
			const exact = await metadataRepository.findByTitleAndType(type, parsed.title);
			if (!exact) return undefined;

			// If both the incoming file and the local record have a release year, verify they match (<= 1 year difference)
			if (parsed.year && exact.releaseDate) {
				const localYear = Number.parseInt(exact.releaseDate.slice(0, 4), 10);
				if (Number.isInteger(localYear) && Math.abs(localYear - parsed.year) > 1) {
					// Different year (e.g. Iron Man 2008 vs Iron Man remake/sequel) - let provider search find the correct one
					return undefined;
				}
			}

			return exact;
		} catch (error) {
			this.logger.debug("Failed to find existing local movie metadata", { type: parsed.type, title: parsed.title, error });

			return undefined;
		}
	}

	/**
	 * Resolves an existing metadata row through the sidecar's external ids
	 * (imdb/tmdb namespaces double as provider names in the providers table).
	 */
	private async findMetadataByIdentifiers(
		type: "movie" | "tv_show",
		sidecar: SidecarMetadataHint,
	): Promise<
		| {
				metadataId: string;
				stableKey: string | null;
				metadata: ProviderMetadataResult;
				providers: AggregatedProviderLink[];
		  }
		| undefined
	> {
		for (const namespace of ["tmdb", "imdb"] as const) {
			const externalId = sidecar.identifiers[namespace];
			if (!externalId) continue;

			const [row] = await metadataRepository.findByProviderExternalIds({
				providerName: namespace,
				entityType: type,
				externalIds: [externalId],
			});
			if (!row) continue;

			return {
				metadataId: row.metadata.id,
				stableKey: row.metadata.stableKey,
				metadata: { externalId: row.externalId, title: row.metadata.title, releaseDate: row.metadata.releaseDate },
				providers: [{ providerId: namespace, externalId }],
			};
		}

		return undefined;
	}

	/**
	 * Offline import: builds the metadata row from the NFO payload itself.
	 * `providerName` records the id namespace (tmdb/imdb) or "sidecar"; the
	 * provider link + stable key make rescans idempotent. Local artwork paths
	 * ride on posterPath/backdropPath — the image pipeline accepts local files.
	 */
	private async createSidecarMetadata(
		type: "movie" | "tv_show",
		sidecar: SidecarMetadataHint,
	): Promise<{ base: BaseMetadataProcess; providers: AggregatedProviderLink[] } | undefined> {
		const title = sidecar.title;
		if (!title) return undefined;

		let identifier: { readonly providerId: "tmdb" | "imdb"; readonly externalId: string } | undefined;
		if (sidecar.identifiers.tmdb) {
			identifier = { providerId: "tmdb", externalId: sidecar.identifiers.tmdb };
		} else if (sidecar.identifiers.imdb) {
			identifier = { providerId: "imdb", externalId: sidecar.identifiers.imdb };
		}

		const externalId = identifier?.externalId ?? `nfo-${slugify(title)}${sidecar.year ? `-${sidecar.year}` : ""}`;
		this.logger.info("Importing metadata from local sidecar", { type, title, source: identifier?.providerId ?? "sidecar" });

		const base = await this.ensureBaseMetadata(
			type,
			identifier?.providerId ?? "sidecar",
			{
				externalId,
				title,
				originalTitle: sidecar.originalTitle,
				overview: sidecar.overview,
				releaseDate: sidecar.releaseDate ?? (sidecar.year ? `${sidecar.year}-01-01` : ""),
				genres: sidecar.genres?.map((name) => ({ id: `nfo-genre-${slugify(name)}`, name })),
				posterPath: sidecar.posterPath,
				backdropPath: sidecar.backdropPath,
			},
			1,
			identifier ? [identifier] : [{ providerId: "sidecar", externalId }],
		);

		return { base, providers: identifier ? [identifier] : [{ providerId: "sidecar", externalId }] };
	}

	private async resolveLocalTVShow(
		existingMetadata: { id: string; title: string; releaseDate: string | null; stableKey?: string | null },
		parsed: MediaIdentity,
		scheduling?: TaskSchedulingOptions,
	): Promise<MetadataProcessResult | undefined> {
		if (parsed.season === undefined) return undefined;

		try {
			const season = await seasonsRepository.findByMetadataAndNumber(existingMetadata.id, parsed.season);

			if (season && parsed.episode !== undefined) {
				const episode = await episodesRepository.findBySeasonAndNumber(season.id, parsed.episode);
				if (episode) {
					return { metadataId: existingMetadata.id, movieId: null, episodeId: episode.id };
				}
			}

			const providerLink = await metadataRepository.findFirstProviderLink(existingMetadata.id);

			if (providerLink) {
				const pseudoMetadata: ProviderMetadataResult = {
					externalId: providerLink.externalId,
					title: existingMetadata.title,
					releaseDate: existingMetadata.releaseDate ?? "",
				};

				return await this.processTVShowMetadata(existingMetadata.id, parsed, pseudoMetadata, existingMetadata.stableKey, scheduling, [
					{ providerId: providerLink.name, externalId: providerLink.externalId },
				]);
			}
		} catch (error) {
			this.logger.debug("Failed to resolve local TV show", { externalId: existingMetadata.id, error });

			return undefined;
		}

		return undefined;
	}

	private async ensureBaseMetadata(
		type: "movie" | "tv_show",
		providerName: string,
		providerMetadata: ProviderMetadataResult,
		matchScore?: number,
		providers?: AggregatedProviderLink[],
	): Promise<BaseMetadataProcess> {
		const key = `${providerName}:${type}:${providerMetadata.externalId}`;
		const existing = this.baseMetadataProcesses.get(key);
		if (existing) return await existing;

		const processing = this.createBaseMetadata(type, providerName, providerMetadata, matchScore, providers);
		this.baseMetadataProcesses.set(key, processing);
		try {
			return await processing;
		} finally {
			this.baseMetadataProcesses.delete(key);
		}
	}

	private async createBaseMetadata(
		type: "movie" | "tv_show",
		providerName: string,
		providerMetadata: ProviderMetadataResult,
		matchScore?: number,
		providers?: AggregatedProviderLink[],
	): Promise<BaseMetadataProcess> {
		const candidate = await pluginsService.transformMetadataCandidate(toMetadataCandidate(type, providerName, providerMetadata));
		const metadata = applyMetadataCandidate(type, providerName, providerMetadata, candidate);
		const result = await metadataPersistenceRepository.createProviderMetadata({ type, providerName, providers, metadata, matchScore });

		return {
			metadataId: result.metadata.id,
			metadata,
			metadataStableKey: result.metadata.stableKey,
			created: result.created,
			personImages: result.personImages,
		};
	}

	private async enqueueBaseMetadataImages(baseMetadata: BaseMetadataProcess, scheduling?: TaskSchedulingOptions): Promise<void> {
		if (!baseMetadata.created) return;

		const existing = this.imageEnqueueProcesses.get(baseMetadata.metadataId);
		if (existing) return await existing;

		const processing = this.enqueueBaseMetadataImagesOnce(baseMetadata, scheduling);
		this.imageEnqueueProcesses.set(baseMetadata.metadataId, processing);
		try {
			await processing;
		} finally {
			if (this.imageEnqueueProcesses.get(baseMetadata.metadataId) === processing) {
				this.imageEnqueueProcesses.delete(baseMetadata.metadataId);
			}
		}
	}

	private async enqueueBaseMetadataImagesOnce(baseMetadata: BaseMetadataProcess, scheduling?: TaskSchedulingOptions): Promise<void> {
		await this.enqueueImages(
			{
				kind: "metadata",
				metadataId: baseMetadata.metadataId,
				urls: [
					{ type: "poster", url: baseMetadata.metadata.posterPath },
					{ type: "backdrop", url: baseMetadata.metadata.backdropPath },
				],
			},
			scheduling,
		);

		const personImages = baseMetadata.personImages.slice(0, serverConfig.application.metadataPersonImageLimit);
		await PromiseUtils.mapConcurrent(personImages, serverConfig.application.metadataImageEnqueueConcurrency, ({ personId, url }) =>
			this.enqueueImages({ kind: "person", personId, urls: url }, scheduling),
		);
		pluginsService.publish("metadata.saved", { metadataId: baseMetadata.metadataId });
	}

	private async processMovieMetadata(metadataId: string, metadataStableKey?: string | null): Promise<MetadataProcessResult | undefined> {
		const movie = await moviesRepository.findOrCreateByMetadataId({ metadataId, metadataStableKey });

		if (!movie) {
			this.logger.error("Failed to find/create movie entry", { metadataId });

			return undefined;
		}

		return { metadataId, movieId: movie.id, episodeId: null };
	}

	private async processTVShowMetadata(
		metadataId: string,
		parsed: MediaIdentity,
		metadata: ProviderMetadataResult,
		metadataStableKey?: string | null,
		scheduling?: TaskSchedulingOptions,
		providers?: AggregatedProviderLink[],
		sidecarHint?: SidecarMetadataHint,
	): Promise<MetadataProcessResult | undefined> {
		if (parsed.season === undefined) {
			this.logger.warn("TV show missing season number in identity", { parsed });

			return undefined;
		}

		const providerLinks = (providers ?? []).map((provider) => ({ providerId: provider.providerId, externalId: provider.externalId }));

		let seasonInfo: ProviderSeasonResult | undefined;
		if (metadata.seasons) {
			const seasonsByNumber = toMap(metadata.seasons, (s) => s.seasonNumber);
			seasonInfo = seasonsByNumber.get(parsed.season);
		}

		if (!seasonInfo?.episodes || seasonInfo.episodes.length === 0) {
			const fetchedSeason = (await pluginsService.fetchProviderSeasonFromLinks(providerLinks, parsed.season))[0]?.metadata;
			if (fetchedSeason) {
				seasonInfo = seasonInfo
					? { ...seasonInfo, ...fetchedSeason, episodes: fetchedSeason.episodes ?? seasonInfo.episodes }
					: fetchedSeason;
			}
		}

		if (!seasonInfo) {
			this.logger.warn("TV show missing season info from provider, using fallback", {
				externalId: metadata.externalId,
				seasonNumber: parsed.season,
			});
			seasonInfo = {
				externalId: `${metadata.externalId}-s${parsed.season}`,
				seasonNumber: parsed.season,
				name: sidecarHint?.seasonName,
				posterPath: sidecarHint?.seasonPosterPath,
			};
		}

		let episodeInfo: ProviderEpisodeResult | undefined;
		if (parsed.episode !== undefined && seasonInfo.episodes) {
			const episodesByNumber = toMap(seasonInfo.episodes, (e) => e.episodeNumber);
			episodeInfo = episodesByNumber.get(parsed.episode);
		}

		if (parsed.episode !== undefined && !episodeInfo) {
			episodeInfo = (await pluginsService.fetchProviderEpisodeFromLinks(providerLinks, Number(seasonInfo.seasonNumber), parsed.episode))[0]
				?.metadata;
		}

		if (parsed.episode !== undefined && !episodeInfo) {
			this.logger.warn("TV show missing episode info from provider, using fallback", { parsed });
			episodeInfo = {
				externalId: `${metadata.externalId}-s${seasonInfo.seasonNumber}-e${parsed.episode}`,
				episodeNumber: parsed.episode,
				seasonNumber: Number(seasonInfo.seasonNumber),
				name: sidecarHint?.episodeName,
				thumbnailPath: sidecarHint?.episodeThumbnailPath,
			};
		}

		// Season/episode data arrived with fallback-language content — raise the
		// series-level flag so the admin missing-translation filter finds it.
		if (seasonInfo.hasMissingTranslation === true || episodeInfo?.hasMissingTranslation === true) {
			await metadataRepository.flagMissingTranslation(metadataId);
		}

		// Keep season and episode creation atomic. Provider calls happen before the
		// transaction so a slow integration cannot hold SQLite write locks.
		const persisted = await metadataPersistenceRepository.createSeasonAndEpisode({
			metadataId,
			metadataStableKey,
			seasonInfo,
			episodeInfo,
		});

		if (!persisted) {
			this.logger.error("Failed to find/create season entry", { metadataId, seasonNumber: seasonInfo.seasonNumber });

			return undefined;
		}

		if (seasonInfo.posterPath) {
			await this.enqueueImages(
				{
					kind: "season",
					metadataId,
					seasonId: persisted.season.id,
					seasonNumber: `${persisted.season.seasonNumber}`,
					urls: seasonInfo.posterPath,
				},
				scheduling,
			);
		}

		if (parsed.episode === undefined) {
			return { metadataId, movieId: null, episodeId: null };
		}

		if (!persisted.episode) {
			this.logger.error("Failed to find/create episode entry", { seasonId: persisted.season.id, episodeNumber: parsed.episode });

			return undefined;
		}

		if (episodeInfo?.thumbnailPath) {
			await this.enqueueImages(
				{
					kind: "episode",
					metadataId,
					episodeId: persisted.episode.id,
					seasonNumber: `${persisted.season.seasonNumber}`,
					episodeNumber: `${persisted.episode.episodeNumber}`,
					urls: episodeInfo.thumbnailPath,
				},
				scheduling,
			);
		}

		try {
			await notificationsService.notifyNewEpisode({
				metadataId,
				showTitle: metadata.title,
				seasonNumber: persisted.season.seasonNumber,
				episodeNumber: persisted.episode.episodeNumber,
				episodeTitle: episodeInfo?.name,
			});
		} catch (err) {
			this.logger.warn("Failed to send new episode notification", { err });
		}

		return { metadataId, movieId: null, episodeId: persisted.episode.id };
	}
}
