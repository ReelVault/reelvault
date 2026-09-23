import type { ProviderEpisodeResult, ProviderSeasonResult } from "@sdk/plugin";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { systemResourcesService } from "@/system/system-resources.service";
import { errorMessage } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { PromiseUtils } from "@/utils/promise.utils";

const logger = createLogger("SeasonSync");

export type SeasonImageTask =
	| { kind: "season"; metadataId: string; seasonId: string; seasonNumber: string; urls: string }
	| { kind: "episode"; metadataId: string; episodeId: string; seasonNumber: string; episodeNumber: string; urls: string };

type SeasonRow = Awaited<ReturnType<typeof seasonsRepository.findByMetadataId>>[number];
type EpisodeRow = Awaited<ReturnType<typeof episodesRepository.findBySeasonIds>>[number];

/** First provider entry per integer key (invalid or duplicate keys skipped) — O(1) lookup instead of `.find()` in nested loops. */
function firstWinsByNumber<T>(items: readonly T[], keyOf: (item: T) => string | number | undefined): Map<number, T> {
	const map = new Map<number, T>();
	for (const item of items) {
		const key = Number(keyOf(item));
		if (Number.isInteger(key) && !map.has(key)) map.set(key, item);
	}

	return map;
}

function collectSeasonImageTasks(
	metadataId: string,
	existingSeasons: SeasonRow[],
	seasonsByNumber: Map<number, ProviderSeasonResult>,
): SeasonImageTask[] {
	const tasks: SeasonImageTask[] = [];
	for (const existingSeason of existingSeasons) {
		const seasonInfo = seasonsByNumber.get(existingSeason.seasonNumber);
		if (!seasonInfo) continue;

		if (seasonInfo.posterPath) {
			tasks.push({
				kind: "season",
				metadataId,
				seasonId: existingSeason.id,
				seasonNumber: String(existingSeason.seasonNumber),
				urls: seasonInfo.posterPath,
			});
		}
	}

	return tasks;
}

async function fetchMissingEpisodeMap(
	seasonsNeedingFetch: SeasonRow[],
	fetchMissingEpisodes: ((seasonNumber: number) => Promise<ProviderEpisodeResult[] | undefined>) | undefined,
): Promise<Map<number, ProviderEpisodeResult[]>> {
	const fetchedEpisodes = new Map<number, ProviderEpisodeResult[]>();
	if (!fetchMissingEpisodes || seasonsNeedingFetch.length === 0) return fetchedEpisodes;

	const results = await Promise.allSettled(
		seasonsNeedingFetch.map(async (s) => {
			try {
				const eps = await fetchMissingEpisodes(s.seasonNumber);

				return { seasonNumber: s.seasonNumber, eps };
			} catch (error) {
				// Provider outage / rate limit for one season must not look like a
				// fully successful sync — the catalog silently stays stale.
				logger.warn("Provider episode fetch failed — season left as-is", { seasonNumber: s.seasonNumber, error: errorMessage(error) });

				return { seasonNumber: s.seasonNumber, eps: undefined };
			}
		}),
	);
	for (const r of results) {
		if (r.status === "rejected") {
			logger.warn("Provider episode fetch rejected — season left as-is", { error: errorMessage(r.reason) });
			continue;
		}

		if (r.value.eps) {
			fetchedEpisodes.set(r.value.seasonNumber, r.value.eps);
		}
	}

	return fetchedEpisodes;
}

interface EpisodeWork {
	updatePromises: Array<Promise<unknown>>;
	tasks: SeasonImageTask[];
	/** Any processed provider episode reported fallback-language content. */
	episodeMissingTranslation: boolean;
}

interface EpisodeWorkResult {
	updatePromise?: Promise<unknown>;
	task?: SeasonImageTask;
}

function processExistingEpisode(
	metadataId: string,
	existingSeason: SeasonRow,
	existingEpisode: EpisodeRow,
	episodeInfo: ProviderEpisodeResult,
): EpisodeWorkResult {
	// Drizzle skips `undefined` fields in .set(), so only compare provided values.
	const absoluteNumber = episodeInfo.absoluteNumber !== undefined ? Number(episodeInfo.absoluteNumber) : undefined;
	const changed =
		existingEpisode.title !== episodeInfo.name ||
		(episodeInfo.overview !== undefined && existingEpisode.overview !== episodeInfo.overview) ||
		(episodeInfo.airDate !== undefined && existingEpisode.airDate !== episodeInfo.airDate) ||
		(absoluteNumber !== undefined && existingEpisode.absoluteNumber !== absoluteNumber);

	const result: EpisodeWorkResult = {};
	if (changed) {
		result.updatePromise = episodesRepository.update({
			primaryId: existingEpisode.id,
			values: {
				title: episodeInfo.name,
				overview: episodeInfo.overview,
				airDate: episodeInfo.airDate,
				...(absoluteNumber !== undefined ? { absoluteNumber } : {}),
			},
		});
	}

	if (episodeInfo.thumbnailPath) {
		result.task = {
			kind: "episode",
			metadataId,
			episodeId: existingEpisode.id,
			seasonNumber: String(existingSeason.seasonNumber),
			episodeNumber: String(existingEpisode.episodeNumber),
			urls: episodeInfo.thumbnailPath,
		};
	}

	return result;
}

function collectEpisodeWork(params: {
	metadataId: string;
	existingSeasons: SeasonRow[];
	seasonsByNumber: Map<number, ProviderSeasonResult>;
	episodesBySeason: Map<string, EpisodeRow[]>;
	fetchedEpisodes: Map<number, ProviderEpisodeResult[]>;
}): EpisodeWork {
	const { metadataId, existingSeasons, seasonsByNumber, episodesBySeason, fetchedEpisodes } = params;
	const updatePromises: Array<Promise<unknown>> = [];
	const tasks: SeasonImageTask[] = [];
	let episodeMissingTranslation = false;
	for (const existingSeason of existingSeasons) {
		const seasonInfo = seasonsByNumber.get(existingSeason.seasonNumber);
		if (!seasonInfo) continue;

		const existingEpisodes = episodesBySeason.get(existingSeason.id) ?? [];
		if (existingEpisodes.length === 0) continue;

		const episodes =
			seasonInfo.episodes && seasonInfo.episodes.length > 0 ? seasonInfo.episodes : fetchedEpisodes.get(existingSeason.seasonNumber);

		if (!episodes) continue;

		const episodesByNumber = firstWinsByNumber(episodes, (episode) => episode.episodeNumber);

		for (const existingEpisode of existingEpisodes) {
			const episodeInfo = episodesByNumber.get(existingEpisode.episodeNumber);
			if (!episodeInfo) continue;

			if (episodeInfo.hasMissingTranslation === true) episodeMissingTranslation = true;

			const work = processExistingEpisode(metadataId, existingSeason, existingEpisode, episodeInfo);
			if (work.updatePromise !== undefined) updatePromises.push(work.updatePromise);

			if (work.task) tasks.push(work.task);
		}
	}

	return { updatePromises, tasks, episodeMissingTranslation };
}

export async function syncSeasonsAndEpisodes(
	metadataId: string,
	seasons: ProviderSeasonResult[] | undefined,
	fetchMissingEpisodes?: (seasonNumber: number) => Promise<ProviderEpisodeResult[] | undefined>,
): Promise<SeasonImageTask[]> {
	const tasks: SeasonImageTask[] = [];
	if (!seasons || seasons.length === 0) return tasks;

	const existingSeasons = await seasonsRepository.findByMetadataId(metadataId);
	if (existingSeasons.length === 0) return tasks;

	const seasonsByNumber = firstWinsByNumber(seasons, (season) => season.seasonNumber);

	// Batch-update only changed seasons in parallel.
	// Drizzle skips `undefined` fields in .set(), so only compare provided values.
	await PromiseUtils.mapConcurrent(existingSeasons, systemResourcesService.getIoConcurrency(), (existingSeason) => {
		const seasonInfo = seasonsByNumber.get(existingSeason.seasonNumber);
		if (!seasonInfo) return Promise.resolve();

		const changed =
			(seasonInfo.name !== undefined && existingSeason.name !== seasonInfo.name) ||
			(seasonInfo.overview !== undefined && existingSeason.overview !== seasonInfo.overview) ||
			(seasonInfo.airDate !== undefined && existingSeason.airDate !== seasonInfo.airDate) ||
			(seasonInfo.status !== undefined && existingSeason.status !== seasonInfo.status);
		if (!changed) return Promise.resolve();

		return seasonsRepository.update({
			primaryId: existingSeason.id,
			values: {
				name: seasonInfo.name,
				overview: seasonInfo.overview,
				airDate: seasonInfo.airDate,
				status: seasonInfo.status,
			},
		});
	});

	// Propagate child fallback-language content to the series-level flag.
	let missingTranslation = existingSeasons.some((season) => seasonsByNumber.get(season.seasonNumber)?.hasMissingTranslation === true);

	tasks.push(...collectSeasonImageTasks(metadataId, existingSeasons, seasonsByNumber));

	// Batch-fetch all episodes for ALL seasons in one query
	const allSeasonIds = existingSeasons.map((s) => s.id);
	const allExistingEpisodes = await episodesRepository.findBySeasonIds(allSeasonIds);

	// Group episodes by seasonId
	const episodesBySeason = new Map<string, typeof allExistingEpisodes>();
	for (const ep of allExistingEpisodes) {
		const list = episodesBySeason.get(ep.seasonId);
		if (list) list.push(ep);
		else episodesBySeason.set(ep.seasonId, [ep]);
	}

	// Fetch missing episodes for all seasons that need them
	const seasonsNeedingFetch = existingSeasons.filter((s) => {
		const seasonInfo = seasonsByNumber.get(s.seasonNumber);

		return seasonInfo && (!seasonInfo.episodes || seasonInfo.episodes.length === 0) && fetchMissingEpisodes;
	});
	const fetchedEpisodes = await fetchMissingEpisodeMap(seasonsNeedingFetch, fetchMissingEpisodes);

	const {
		updatePromises,
		tasks: episodeTasks,
		episodeMissingTranslation,
	} = collectEpisodeWork({
		metadataId,
		existingSeasons,
		seasonsByNumber,
		episodesBySeason,
		fetchedEpisodes,
	});
	missingTranslation ||= episodeMissingTranslation;

	await PromiseUtils.mapConcurrent(updatePromises, systemResourcesService.getIoConcurrency(), (p) => p);
	tasks.push(...episodeTasks);

	if (missingTranslation) {
		await metadataRepository.flagMissingTranslation(metadataId);
	}

	return tasks;
}
