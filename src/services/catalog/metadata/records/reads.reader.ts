import type {
	CursorPaginatedResponse,
	CursorPaginationQuery,
	FieldsQuery,
	MetadataDetailsViewResponse,
	MetadataFilters,
	MetadataPlaybackProgress,
	MetadataSorting,
	MetadataWithRelation,
	PaginatedResponse,
	PaginationQuery,
	SeasonWithEpisodes,
	SelectFields,
} from "@reelvault/sdk/common";
import type { SmartPlay } from "@/modules/streaming/streaming.types";
import { episodesRepository } from "@/repositories/episodes.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { type MetadataRootRow, metadataRepository } from "@/repositories/metadata.repository";
import type { ProfileScopedFilter } from "@/repositories/metadata-filters.utils";
import { searchGlobal as searchGlobalIndex } from "@/repositories/metadata-search.reader";
import { playbackRepository } from "@/repositories/playback.repository";
import { seasonsRepository } from "@/repositories/seasons.repository";
import { userRatingsRepository } from "@/repositories/user-ratings.repository";
import { watchedHistoryRepository } from "@/repositories/watched-history.repository";
import { watchlistRepository } from "@/repositories/watchlist.repository";
import { playbackProgressService } from "@/services/playback/playback-progress.service";
import { groupBy } from "@/utils/array.utils";
import { assertFound, errorMessage } from "@/utils/domain.errors";
import { clamp } from "@/utils/math.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import type { MetadataServiceState } from "./shared.utils";

/** Profile-scoped filters never take the profile from the query string — the
 * service pairs it with the status into a typed filter value the repository
 * builder consumes. */
function composeProfileScopedFilter(viewerProfileId: string | undefined, status: string | undefined): ProfileScopedFilter | undefined {
	return viewerProfileId && status ? { profileId: viewerProfileId, status } : undefined;
}

export async function getStatuses(): Promise<{ statuses: string[] }> {
	return { statuses: await metadataRepository.findDistinctStatuses() };
}

export async function searchGlobal(state: MetadataServiceState, query: string, limit: number) {
	return await runSafely(state, "searchGlobal", async () => {
		const term = query.trim();
		const safeLimit = clamp(limit, 1, 20);
		if (term.length < 2) return { titles: [], people: [], collections: [], genres: [] };

		return await searchGlobalIndex({ term, limit: safeLimit });
	});
}

export async function getAll<F extends string>(
	state: MetadataServiceState,
	query?: CursorPaginationQuery & FieldsQuery<F> & MetadataFilters & MetadataSorting,
	viewerProfileId?: string,
): Promise<CursorPaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
	return await runSafely(state, "getAll", async () => {
		// Profile-scoped filters never take the profile from the query string —
		// the service pairs the client-facing status with the resolved viewer
		// profile before the repository builder sees the value.
		const { watchedStatus: _clientWatchedStatus, userRating: _clientUserRating, ...clientFilters } = query ?? {};
		const watchedStatus = composeProfileScopedFilter(viewerProfileId, query?.watchedStatus);
		const userRating = composeProfileScopedFilter(viewerProfileId, query?.userRating);

		return await metadataRepository.findPage({
			...clientFilters,
			hasMediaFiles: query?.hasMediaFiles ?? true,
			...(watchedStatus ? { watchedStatus } : {}),
			...(userRating ? { userRating } : {}),
		});
	});
}

export async function getById<F extends string>(
	state: MetadataServiceState,
	metadataId: string,
	query?: FieldsQuery<F>,
): Promise<SelectFields<MetadataWithRelation, F>> {
	return await runSafely(state, "getById", async () => {
		const metadata = await metadataRepository.findByIdForRead(metadataId, query);

		assertFound(metadata, "Metadata", metadataId);

		return metadata;
	});
}

/**
 * Flat metadata row without any relation queries. Use for composite views
 * whose contract only carries the root row (playback view) — getById would
 * run the full detail-page relation load for nothing.
 */
export async function getRootsById(state: MetadataServiceState, metadataId: string): Promise<MetadataRootRow | undefined> {
	return await runSafely(state, "getRootsById", async () => {
		return await metadataRepository.findRootsById(metadataId);
	});
}

export async function getDetailsView(
	state: MetadataServiceState,
	metadataId: string,
	profileId?: string,
): Promise<MetadataDetailsViewResponse> {
	return await runSafely(state, "getDetailsView", async () => {
		const metadata = await metadataRepository.findByIdForRead(metadataId);
		assertFound(metadata, "Metadata", metadataId);

		const isTv = metadata.type === "tv_show";

		let watchedState: Promise<boolean>;
		if (profileId) {
			watchedState = watchedHistoryRepository
				.isWatched(profileId, metadataId)
				// Degraded reads must be visible — a silent false would present
				// watched state as unwatched.
				.catch((error: unknown) => {
					state.logger.warn("Watched-state lookup failed — reporting as unwatched", {
						metadataId,
						profileId,
						error: errorMessage(error),
					});

					return false;
				});
		} else {
			watchedState = Promise.resolve(false);
		}

		let progressRowsPromise: Promise<Awaited<ReturnType<typeof playbackRepository.findProgressRows>>>;
		if (profileId) {
			progressRowsPromise = playbackRepository.findProgressRows(metadataId, profileId).catch((error: unknown) => {
				state.logger.warn("Playback progress lookup failed — reporting as no progress", {
					metadataId,
					profileId,
					error: errorMessage(error),
				});

				return [];
			});
		} else {
			progressRowsPromise = Promise.resolve([]);
		}

		const [seasonsResult, episodesResult, mediaFilesResult, inWatchlist, ratingRecord, isWatchedRecord, progressRows] = await Promise.all([
			isTv ? seasonsRepository.findByMetadataId(metadataId) : Promise.resolve([]),
			isTv ? episodesRepository.findByMetadataIdProjected(metadataId) : Promise.resolve([]),
			// Root rows only — the contract ships MediaFileSchema (no streams), so
			// the per-batch stream/library relation loads would be pure waste.
			mediaRepository.findRootsByMetadataId(metadataId),
			profileId ? watchlistRepository.isWatchlisted(profileId, metadataId) : Promise.resolve(false),
			profileId ? userRatingsRepository.findByProfileAndMetadata(profileId, metadataId) : Promise.resolve(null),
			watchedState,
			progressRowsPromise,
		]);

		const mediaFilesByEpisodeId = groupBy(mediaFilesResult, (m) => m.episodeId);
		const enrichedEpisodes = episodesResult.map((ep) => ({
			...ep,
			mediaFiles: mediaFilesByEpisodeId.get(ep.id) ?? [],
		}));

		// `episodesResult` is empty for non-TV metadata, so no extra guard here.
		const episodesBySeason = groupBy(enrichedEpisodes, (ep) => ep.seasonId);
		const seasonsWithEpisodes: SeasonWithEpisodes[] = seasonsResult.map((season) => ({
			...season,
			episodes: episodesBySeason.get(season.id) ?? [],
		}));

		let progress: MetadataPlaybackProgress | null = null;
		if (profileId) {
			progress = playbackProgressService.computePlaybackProgress({
				metadata,
				mediaFiles: mediaFilesResult,
				progressRows,
				episodes: episodesResult,
			});
		}

		let smartPlay: SmartPlay | null = null;
		if (profileId) {
			smartPlay = playbackProgressService.computeSmartPlay({
				metadata,
				mediaFiles: mediaFilesResult,
				progressRows,
				seasons: seasonsResult,
				episodes: episodesResult,
			});
		}

		return {
			metadata,
			mediaFiles: mediaFilesResult,
			seasons: seasonsWithEpisodes,
			userState: {
				inWatchlist,
				rating: ratingRecord?.rating ?? null,
				isWatched: isWatchedRecord,
				progress: progress ?? null,
			},
			smartPlay: smartPlay?.suggestion ?? null,
		};
	});
}

export async function getSimilar<F extends string>(
	state: MetadataServiceState,
	metadataId: string,
	query?: PaginationQuery & FieldsQuery<F>,
	source?: SelectFields<MetadataWithRelation, string>,
): Promise<PaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
	return await runSafely(state, "getSimilar", () => metadataRepository.findSimilarPage(metadataId, query, source));
}
