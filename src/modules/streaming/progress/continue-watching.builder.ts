import type { ContinueWatchingItem } from "@sdk/common/stream.types";
import { groupBy, toMap } from "@/utils/array.utils";
import { clamp } from "@/utils/math.utils";
import type { ContinueWatchingData } from "../streaming.types";
import { computeProgressPercent } from "../utils/playback-position.utils";
import { latestProgressByEpisode } from "./progress.utils";
import { findMostRecentProgress, nextEpisodeAfter, selectPreferredMediaFile } from "./smart-play";

type ContinueCandidate = ContinueWatchingItem & { updatedAt: Date };

type ProgressRow = ContinueWatchingData["progressRows"][0];
type MetadataRow = ContinueWatchingData["metadataList"][0];
type EpisodeRow = ContinueWatchingData["episodes"][0];
type SeasonRow = ContinueWatchingData["seasons"][0];
type MediaFileRow = ContinueWatchingData["mediaFiles"][0];

interface CandidateContext {
	backdropId: string | null;
	backdropUpdatedAt: Date | null;
}

function movieCandidate(
	meta: MetadataRow,
	movieProgress: ProgressRow | undefined,
	minPositionSeconds: number,
	ctx: CandidateContext,
): ContinueCandidate | null {
	if (!movieProgress || movieProgress.completed || movieProgress.position < minPositionSeconds) return null;

	return {
		mediaFileId: movieProgress.mediaFileId,
		metadata: { id: meta.id, title: meta.title, type: "movie" },
		backdropId: ctx.backdropId,
		backdropUpdatedAt: ctx.backdropUpdatedAt,
		episode: null,
		position: movieProgress.position,
		duration: movieProgress.duration,
		progressPercent: computeProgressPercent(movieProgress.position, movieProgress.duration),
		audioStreamIndex: movieProgress.audioStreamIndex,
		subtitleId: movieProgress.subtitleId,
		updatedAt: movieProgress.updatedAt,
	};
}

function tvCandidate(
	meta: MetadataRow,
	progress: ProgressRow,
	episode: EpisodeRow,
	season: SeasonRow | undefined,
	ctx: CandidateContext,
): ContinueCandidate {
	return {
		mediaFileId: progress.mediaFileId,
		metadata: { id: meta.id, title: meta.title, type: "tv_show" },
		backdropId: ctx.backdropId,
		backdropUpdatedAt: ctx.backdropUpdatedAt,
		episode: season
			? {
					title: episode.title,
					episodeNumber: episode.episodeNumber,
					seasonNumber: season.seasonNumber,
					absoluteNumber: episode.absoluteNumber ?? null,
				}
			: null,
		position: progress.position,
		duration: progress.duration,
		progressPercent: computeProgressPercent(progress.position, progress.duration),
		audioStreamIndex: progress.audioStreamIndex,
		subtitleId: progress.subtitleId,
		updatedAt: progress.updatedAt,
	};
}

function nextEpisodeCandidate(
	meta: MetadataRow,
	nextEp: EpisodeRow,
	nextPreferredFile: MediaFileRow,
	nextSeason: SeasonRow | undefined,
	activeProgress: ProgressRow,
	episodeProgressMap: ReadonlyMap<string, ProgressRow>,
	ctx: CandidateContext,
): ContinueCandidate | null {
	const nextProgress = episodeProgressMap.get(nextEp.id);
	const hasNewerProgress = nextProgress && nextProgress.updatedAt.getTime() > activeProgress.updatedAt.getTime();
	if (hasNewerProgress) return null;

	return {
		mediaFileId: nextPreferredFile.id,
		metadata: { id: meta.id, title: meta.title, type: "tv_show" },
		backdropId: ctx.backdropId,
		backdropUpdatedAt: ctx.backdropUpdatedAt,
		episode: nextSeason
			? {
					title: nextEp.title,
					episodeNumber: nextEp.episodeNumber,
					seasonNumber: nextSeason.seasonNumber,
					absoluteNumber: nextEp.absoluteNumber ?? null,
				}
			: null,
		position: 0,
		duration: nextPreferredFile.duration ?? 0,
		progressPercent: 0,
		updatedAt: activeProgress.updatedAt,
	};
}

function buildTvCandidate(
	meta: MetadataRow,
	metadataId: string,
	mediaFilesByMetadataId: Map<string, MediaFileRow[]>,
	seasonsByMetadataId: Map<string, SeasonRow[]>,
	episodesBySeasonId: Map<string, EpisodeRow[]>,
	seasonById: Map<string, SeasonRow>,
	episodeProgressMap: ReadonlyMap<string, ProgressRow>,
	minPositionSeconds: number,
	ctx: CandidateContext,
): ContinueCandidate | null {
	const metaFiles = mediaFilesByMetadataId.get(metadataId) ?? [];
	const metaSeasons = seasonsByMetadataId.get(metadataId) ?? [];
	const metaEpisodes = metaSeasons.flatMap((s) => episodesBySeasonId.get(s.id) ?? []);
	const filesByEpisodeId = groupBy(metaFiles, (file) => file.episodeId);

	const playableEpisodes = metaEpisodes.filter((ep) => filesByEpisodeId.has(ep.id));
	playableEpisodes.sort((a, b) => {
		const sA = seasonById.get(a.seasonId)?.seasonNumber ?? 0;
		const sB = seasonById.get(b.seasonId)?.seasonNumber ?? 0;

		return sA - sB || a.episodeNumber - b.episodeNumber;
	});

	if (playableEpisodes.length === 0) return null;

	const active = findMostRecentProgress(playableEpisodes, episodeProgressMap);
	if (!active) return null;

	const activeEpisode = active.episode;
	const activeProgress = active.progress;

	const activeSeason = seasonById.get(activeEpisode.seasonId);

	if (!activeProgress.completed && activeProgress.position >= minPositionSeconds) {
		return tvCandidate(meta, activeProgress, activeEpisode, activeSeason, ctx);
	}

	if (activeProgress.completed) {
		const nextEp = nextEpisodeAfter(playableEpisodes, activeEpisode.id);
		if (!nextEp) return null;

		const nextSeason = seasonById.get(nextEp.seasonId);
		const nextEpFiles = filesByEpisodeId.get(nextEp.id) ?? [];
		const nextPreferredFile = selectPreferredMediaFile(nextEpFiles);

		if (nextPreferredFile) {
			return nextEpisodeCandidate(meta, nextEp, nextPreferredFile, nextSeason, activeProgress, episodeProgressMap, ctx);
		}
	}

	return null;
}

export function buildContinueWatching(data: ContinueWatchingData, limit: number, minPositionSeconds = 0): ContinueWatchingItem[] {
	const { progressRows, metadataList, mediaFiles, seasons, episodes, backdrops } = data;

	if (progressRows.length === 0) {
		return [];
	}

	const backdropByMetadataId = toMap(
		backdrops,
		(b) => b.metadataId,
		(b) => ({ imageId: b.imageId, updatedAt: b.imageUpdatedAt }),
	);
	const metadataById = toMap(metadataList, (m) => m.id);
	const seasonById = toMap(seasons, (s) => s.id);

	const progressByMetadataId = groupBy(progressRows, (row) => row.metadataId);
	const mediaFilesByMetadataId = groupBy(mediaFiles, (file) => file.metadataId);
	const seasonsByMetadataId = groupBy(seasons, (s) => s.metadataId);
	const episodesBySeasonId = groupBy(episodes, (ep) => ep.seasonId);

	const episodeProgressMap = latestProgressByEpisode(progressRows);

	const candidates: ContinueCandidate[] = [];

	for (const [metadataId, mProgressRows] of progressByMetadataId) {
		const meta = metadataById.get(metadataId);
		if (!meta) continue;

		const backdrop = backdropByMetadataId.get(metadataId) ?? null;
		const ctx: CandidateContext = { backdropId: backdrop?.imageId ?? null, backdropUpdatedAt: backdrop?.updatedAt ?? null };

		if (meta.type === "movie") {
			const movieProgress = mProgressRows.find((p) => p.movieId !== null) ?? mProgressRows[0];
			const candidate = movieCandidate(meta, movieProgress, minPositionSeconds, ctx);
			if (candidate) candidates.push(candidate);

			continue;
		}

		const tvCandidateResult = buildTvCandidate(
			meta,
			metadataId,
			mediaFilesByMetadataId,
			seasonsByMetadataId,
			episodesBySeasonId,
			seasonById,
			episodeProgressMap,
			minPositionSeconds,
			ctx,
		);
		if (tvCandidateResult) candidates.push(tvCandidateResult);
	}

	candidates.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

	const clampedLimit = clamp(limit, 1, 50);

	return candidates.slice(0, clampedLimit).map(({ updatedAt: _, ...item }) => item);
}
