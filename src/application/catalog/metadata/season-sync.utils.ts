import type { ProviderEpisodeResult, ProviderSeasonResult } from "@reelvault/sdk/plugin";
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

/**
 * Drizzle skips `undefined` fields in .set(), so only provided values count as
 * changes. Returns whether any of `keys` differs from the stored row.
 */
function changedFields<T extends object>(
	existing: T,
	provided: { [K in keyof T]?: T[K] | undefined },
	keys: ReadonlyArray<keyof T>,
): boolean {
	return keys.some((key) => provided[key] !== undefined && existing[key] !== provided[key]);
}

/** Returns true when the provider episode reported fallback-language content. */
function processExistingEpisode(
	metadataId: string,
	existingSeason: SeasonRow,
	existingEpisode: EpisodeRow,
	episodeInfo: ProviderEpisodeResult,
	updatePromises: Array<Promise<unknown>>,
	tasks: SeasonImageTask[],
): boolean {
	// Drizzle skips `undefined` fields in .set(), so only compare provided values.
	const absoluteNumber = episodeInfo.absoluteNumber !== undefined ? Number(episodeInfo.absoluteNumber) : undefined;
	const changed =
		existingEpisode.title !== episodeInfo.name ||
		changedFields(existingEpisode, { overview: episodeInfo.overview, airDate: episodeInfo.airDate, absoluteNumber }, [
			"overview",
			"airDate",
			"absoluteNumber",
		]);

	if (changed) {
		updatePromises.push(
			episodesRepository.update({
				primaryId: existingEpisode.id,
				values: {
					title: episodeInfo.name,
					overview: episodeInfo.overview,
					airDate: episodeInfo.airDate,
					...(absoluteNumber !== undefined ? { absoluteNumber } : {}),
				},
			}),
		);
	}

	if (episodeInfo.thumbnailPath) {
		tasks.push({
			kind: "episode",
			metadataId,
			episodeId: existingEpisode.id,
			seasonNumber: String(existingSeason.seasonNumber),
			episodeNumber: String(existingEpisode.episodeNumber),
			urls: episodeInfo.thumbnailPath,
		});
	}

	return episodeInfo.hasMissingTranslation === true;
}

function processExistingEpisodes(
	params: {
		metadataId: string;
		existingSeasons: SeasonRow[];
		seasonsByNumber: Map<number, ProviderSeasonResult>;
		episodesBySeason: Map<string, EpisodeRow[]>;
		fetchedEpisodes: Map<number, ProviderEpisodeResult[]>;
	},
	updatePromises: Array<Promise<unknown>>,
	tasks: SeasonImageTask[],
): boolean {
	const { metadataId, existingSeasons, seasonsByNumber, episodesBySeason, fetchedEpisodes } = params;
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

			if (processExistingEpisode(metadataId, existingSeason, existingEpisode, episodeInfo, updatePromises, tasks)) {
				episodeMissingTranslation = true;
			}
		}
	}

	return episodeMissingTranslation;
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

		const values = { name: seasonInfo.name, overview: seasonInfo.overview, airDate: seasonInfo.airDate, status: seasonInfo.status };
		if (!changedFields(existingSeason, values, ["name", "overview", "airDate", "status"])) return Promise.resolve();

		return seasonsRepository.update({ primaryId: existingSeason.id, values });
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

	const updatePromises: Array<Promise<unknown>> = [];
	const episodeTasks: SeasonImageTask[] = [];
	const episodeMissingTranslation = processExistingEpisodes(
		{ metadataId, existingSeasons, seasonsByNumber, episodesBySeason, fetchedEpisodes },
		updatePromises,
		episodeTasks,
	);
	missingTranslation ||= episodeMissingTranslation;

	await PromiseUtils.mapConcurrent(updatePromises, systemResourcesService.getIoConcurrency(), (p) => p);
	tasks.push(...episodeTasks);

	if (missingTranslation) {
		await metadataRepository.flagMissingTranslation(metadataId);
	}

	return tasks;
}
