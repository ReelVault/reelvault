import type { MediaIdentity } from "@reelvault/sdk/common";
import type { ProviderEpisodeResult, ProviderMetadataResult, ProviderSeasonResult } from "@reelvault/sdk/plugin";
import { providerService } from "@/plugins/capabilities/provider.service";
import { metadataPersistenceRepository } from "@/repositories/metadata-persistence.repository";
import { moviesRepository } from "@/repositories/movies.repository";
import { fallbackEpisodeExternalId, fallbackSeasonExternalId, fetchSeason, firstWinsByNumber } from "@/services/catalog/catalog.utils";
import { notificationsService } from "@/services/notifications/notifications.service";
import type { MetadataProcessResult, MetadataProcessState, TvProcessOptions } from "./shared.types";

type ProviderLinks = Array<{ providerId: string; externalId: string }>;

export async function processMovieMetadata(
	state: MetadataProcessState,
	metadataId: string,
	metadataStableKey?: string | null,
): Promise<MetadataProcessResult | undefined> {
	const movie = await moviesRepository.findOrCreateByMetadataId({ metadataId, metadataStableKey });

	if (!movie) {
		state.logger.error("Failed to find/create movie entry", { metadataId });

		return undefined;
	}

	return { metadataId, movieId: movie.id, episodeId: null };
}

export async function processTVShowMetadata(
	state: MetadataProcessState,
	metadataId: string,
	parsed: MediaIdentity,
	metadata: ProviderMetadataResult,
	options: TvProcessOptions = {},
): Promise<MetadataProcessResult | undefined> {
	const { metadataStableKey, scheduling, providers, sidecarHint, language } = options;
	if (parsed.season === undefined) {
		state.logger.warn("TV show missing season number in identity", { parsed });

		return undefined;
	}

	const providerLinks = (providers ?? []).map((provider) => ({ providerId: provider.providerId, externalId: provider.externalId }));

	const seasonInfo = await resolveSeasonInfo(state, { metadata, seasonNumber: parsed.season, providerLinks, sidecarHint, language });
	const episodeInfo = await resolveEpisodeInfo(state, { parsed, metadata, seasonInfo, providerLinks, sidecarHint, language });

	// Keep season, episode and the fallback-language flag atomic. Provider calls
	// happen before the transaction so a slow integration cannot hold SQLite
	// write locks; the flag rides the same transaction instead of being a
	// standalone main-connection write that busy-waits on the tx lock.
	const persisted = await metadataPersistenceRepository.createSeasonAndEpisode({
		metadataId,
		metadataStableKey,
		seasonInfo,
		episodeInfo,
		flagMissingTranslation: seasonInfo.hasMissingTranslation === true || episodeInfo?.hasMissingTranslation === true,
	});

	if (!persisted) {
		state.logger.error("Failed to find/create season entry", { metadataId, seasonNumber: seasonInfo.seasonNumber });

		return undefined;
	}

	if (seasonInfo.posterPath) {
		await state.enqueueImages(
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
		state.logger.error("Failed to find/create episode entry", { seasonId: persisted.season.id, episodeNumber: parsed.episode });

		return undefined;
	}

	if (episodeInfo?.thumbnailPath) {
		await state.enqueueImages(
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

	if (persisted.episodeCreated) {
		try {
			await notificationsService.notifyNewEpisode({
				metadataId,
				showTitle: metadata.title,
				seasonNumber: persisted.season.seasonNumber,
				episodeNumber: persisted.episode.episodeNumber,
				episodeTitle: episodeInfo?.name,
			});
		} catch (error) {
			state.logger.warn("Failed to send new episode notification", { err: error });
		}
	}

	return { metadataId, movieId: null, episodeId: persisted.episode.id };
}

/** The season for this file from the provider's data, or a synthesized season so the file stays attached. */
async function resolveSeasonInfo(
	state: MetadataProcessState,
	input: {
		metadata: ProviderMetadataResult;
		seasonNumber: number;
		providerLinks: ProviderLinks;
		sidecarHint: TvProcessOptions["sidecarHint"];
		language: TvProcessOptions["language"];
	},
): Promise<ProviderSeasonResult> {
	const { metadata, seasonNumber, providerLinks, sidecarHint, language } = input;

	let seasonInfo: ProviderSeasonResult | undefined;
	if (metadata.seasons) {
		const seasonsByNumber = firstWinsByNumber(metadata.seasons, (s) => s.seasonNumber);
		seasonInfo = seasonsByNumber.get(seasonNumber);
	}

	if (!seasonInfo?.episodes || seasonInfo.episodes.length === 0) {
		const fetchedSeason = await fetchSeason(providerLinks, seasonNumber, language);
		if (fetchedSeason) {
			seasonInfo = seasonInfo
				? { ...seasonInfo, ...fetchedSeason, episodes: fetchedSeason.episodes ?? seasonInfo.episodes }
				: fetchedSeason;
		}
	}

	if (seasonInfo) return seasonInfo;

	state.logger.warn("TV show missing season info from provider, using fallback", {
		externalId: metadata.externalId,
		seasonNumber,
	});

	return {
		externalId: fallbackSeasonExternalId(metadata.externalId, seasonNumber),
		seasonNumber,
		name: sidecarHint?.seasonName,
		posterPath: sidecarHint?.seasonPosterPath,
	};
}

/** The episode for this file from the season's provider data, or a synthesized episode when none resolves. */
async function resolveEpisodeInfo(
	state: MetadataProcessState,
	input: {
		parsed: MediaIdentity;
		metadata: ProviderMetadataResult;
		seasonInfo: ProviderSeasonResult;
		providerLinks: ProviderLinks;
		sidecarHint: TvProcessOptions["sidecarHint"];
		language: TvProcessOptions["language"];
	},
): Promise<ProviderEpisodeResult | undefined> {
	const { parsed, metadata, seasonInfo, providerLinks, sidecarHint, language } = input;

	let episodeInfo: ProviderEpisodeResult | undefined;
	if (parsed.episode !== undefined && seasonInfo.episodes) {
		const episodesByNumber = firstWinsByNumber(seasonInfo.episodes, (e) => e.episodeNumber);
		episodeInfo = episodesByNumber.get(parsed.episode);
	}

	// A season payload can list the episode without its overview; the single-episode
	// endpoint carries it. Responses are cached per episode, so this costs one call at most.
	if (parsed.episode !== undefined && !episodeInfo?.overview) {
		const fetchedEpisode = (
			await providerService.fetchEpisodeFromLinks(providerLinks, Number(seasonInfo.seasonNumber), parsed.episode, language)
		)[0]?.metadata;
		if (fetchedEpisode && (!episodeInfo || fetchedEpisode.overview)) episodeInfo = fetchedEpisode;
	}

	if (parsed.episode === undefined || episodeInfo) return episodeInfo;

	state.logger.warn("TV show missing episode info from provider, using fallback", { parsed });

	return {
		externalId: fallbackEpisodeExternalId(metadata.externalId, seasonInfo.seasonNumber, parsed.episode),
		episodeNumber: parsed.episode,
		seasonNumber: Number(seasonInfo.seasonNumber),
		name: sidecarHint?.episodeName,
		thumbnailPath: sidecarHint?.episodeThumbnailPath,
	};
}
