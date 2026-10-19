import type { SmartPlaySuggestion } from "@/modules/streaming/streaming.types";
import { groupBy, toMap } from "@/utils/array.utils";
import { latestProgressByEpisode } from "./progress.utils";

interface MediaFile {
	id: string;
	episodeId: string | null;
	updatedAt: Date;
	isDefault: boolean;
}

interface Episode {
	id: string;
	seasonNumber: number;
	episodeNumber: number;
	absoluteNumber?: number | null;
}

interface EpisodeWithSeason {
	id: string;
	seasonId: string;
	episodeNumber: number;
}

interface Season {
	id: string;
	seasonNumber: number;
}

interface PlaybackProgress {
	mediaFileId: string;
	episodeId: string | null;
	position: number;
	completed: boolean;
	audioStreamIndex?: number | null | undefined;
	subtitleId?: string | null | undefined;
	updatedAt?: Date | undefined;
}

export function selectPreferredMediaFile<T extends { id: string; isDefault: boolean; updatedAt: Date }>(
	mediaFiles: readonly T[],
): T | undefined {
	let newest: T | undefined;
	let newestDefault: T | undefined;
	for (const mediaFile of mediaFiles) {
		const target = mediaFile.isDefault ? newestDefault : newest;
		const targetTime = target?.updatedAt.getTime();
		const mediaFileTime = mediaFile.updatedAt.getTime();
		if (!target || mediaFileTime > (targetTime ?? Number.NEGATIVE_INFINITY) || (mediaFileTime === targetTime && mediaFile.id < target.id)) {
			if (mediaFile.isDefault) newestDefault = mediaFile;
			else newest = mediaFile;
		}
	}

	return newestDefault ?? newest;
}

/** First playable episode whose progress row has the most recent `updatedAt` (ties keep the earlier episode). */
export function findMostRecentProgress<E extends { id: string }, P extends { updatedAt?: Date | undefined }>(
	playableEpisodes: readonly E[],
	progressByEpisodeId: ReadonlyMap<string, P>,
): { episode: E; progress: P } | undefined {
	let best: { episode: E; progress: P } | undefined;
	for (const episode of playableEpisodes) {
		const progress = progressByEpisodeId.get(episode.id);
		if (!progress) continue;

		if (!best || (progress.updatedAt?.getTime() ?? 0) > (best.progress.updatedAt?.getTime() ?? 0)) {
			best = { episode, progress };
		}
	}

	return best;
}

/** Episode right after `currentId` in the already-sorted list, or undefined at the end / when not found. */
export function nextEpisodeAfter<E extends { id: string }>(playableEpisodes: readonly E[], currentId: string): E | undefined {
	const currentIndex = playableEpisodes.findIndex((episode) => episode.id === currentId);
	if (currentIndex < 0 || currentIndex >= playableEpisodes.length - 1) return undefined;

	return playableEpisodes[currentIndex + 1];
}

/**
 * Preferred media file of the episode right after `currentId` in an already
 * ordered list. Callers own the ordering and the "no next episode" fallback
 * (the playback view scans later seasons; smart play already lists every
 * playable episode across seasons).
 */
export function selectNextEpisodeFile<E extends { id: string }, F extends { id: string; isDefault: boolean; updatedAt: Date }>(
	orderedEpisodes: readonly E[],
	currentId: string,
	mediaFilesFor: (episode: E) => readonly F[],
): F | undefined {
	const next = nextEpisodeAfter(orderedEpisodes, currentId);

	return next ? selectPreferredMediaFile(mediaFilesFor(next)) : undefined;
}

/**
 * Next-episode file after `current` for the playback view, computed from the
 * smart-play source data of the show (so the view's own read can go): the
 * immediate next episode in the current season, else the first playable episode
 * of each later season in season order. Episodes are ordered by (seasonNumber,
 * episodeNumber) — the old row read's order; episodes without files stay in it
 * so the immediate next episode is still "no file" (which falls through to
 * later seasons) rather than skipping ahead within the season.
 */
export function selectNextEpisodeFileInSeries(
	episodes: readonly EpisodeWithSeason[],
	seasons: readonly Season[],
	mediaFiles: readonly MediaFile[],
	current: { id: string; seasonId: string },
): string | null {
	const seasonNumberById = toMap(
		seasons,
		(season) => season.id,
		(season) => season.seasonNumber,
	);
	const ordered: Array<{ episode: EpisodeWithSeason; seasonNumber: number }> = [];
	for (const episode of episodes) {
		const seasonNumber = seasonNumberById.get(episode.seasonId);
		if (seasonNumber !== undefined) ordered.push({ episode, seasonNumber });
	}

	ordered.sort((left, right) => left.seasonNumber - right.seasonNumber || left.episode.episodeNumber - right.episode.episodeNumber);

	const filesByEpisode = groupBy(mediaFiles, (mediaFile) => mediaFile.episodeId);
	const filesOf = (episode: EpisodeWithSeason): readonly MediaFile[] => filesByEpisode.get(episode.id) ?? [];

	const nextFile = selectNextEpisodeFile(
		ordered.filter((entry) => entry.episode.seasonId === current.seasonId).map((entry) => entry.episode),
		current.id,
		filesOf,
	);
	if (nextFile) return nextFile.id;

	// The current episode must be part of the show data for the later-season
	// fallback: without it there is no season number to compare against.
	const currentEntry = ordered.find((entry) => entry.episode.id === current.id);
	if (!currentEntry) return null;

	const firstEpisodeBySeason = new Map<number, EpisodeWithSeason>();
	for (const entry of ordered) {
		if (!firstEpisodeBySeason.has(entry.seasonNumber)) firstEpisodeBySeason.set(entry.seasonNumber, entry.episode);
	}

	for (const seasonNumber of [...firstEpisodeBySeason.keys()].toSorted((left, right) => left - right)) {
		if (seasonNumber <= currentEntry.seasonNumber) continue;

		const firstEpisode = firstEpisodeBySeason.get(seasonNumber);
		const file = firstEpisode ? selectPreferredMediaFile(filesOf(firstEpisode)) : undefined;
		if (file) return file.id;
	}

	return null;
}

export function selectMovieSmartPlay(mediaFiles: readonly MediaFile[], progress?: PlaybackProgress): SmartPlaySuggestion | undefined {
	if (progress && !progress.completed && progress.position > 0 && mediaFiles.some((f) => f.id === progress.mediaFileId)) {
		return {
			type: "continue",
			mediaFileId: progress.mediaFileId,
			...(progress.audioStreamIndex === undefined ? {} : { audioStreamIndex: progress.audioStreamIndex }),
			...(progress.subtitleId === undefined ? {} : { subtitleId: progress.subtitleId }),
		};
	}

	const mediaFile = selectPreferredMediaFile(mediaFiles);

	return mediaFile ? { type: "new", mediaFileId: mediaFile.id } : undefined;
}

export function selectEpisodeSmartPlay(
	episodes: readonly Episode[],
	mediaFiles: readonly MediaFile[],
	watchedEpisodeIds: ReadonlySet<string>,
	progress: readonly PlaybackProgress[],
	numberingMode?: string | null,
): SmartPlaySuggestion | undefined {
	const filesByEpisode = groupBy(mediaFiles, (mediaFile) => mediaFile.episodeId);

	const useAbsolute = numberingMode === "absolute";
	const playableEpisodes = episodes.filter((episode) => filesByEpisode.has(episode.id));
	playableEpisodes.sort((left, right) => compareEpisodes(left, right, useAbsolute));
	if (playableEpisodes.length === 0) return undefined;

	const progressByEpisode = latestProgressByEpisode(progress, (item, episodeId) => {
		const files = filesByEpisode.get(episodeId);

		return Boolean(files?.some((file) => file.id === item.mediaFileId));
	});

	// Find the episode with the most recent progress activity
	const recent = findMostRecentProgress(playableEpisodes, progressByEpisode);
	if (recent) {
		const continued = continueSuggestion(recent.progress);
		if (continued) return continued;

		const nextEpisode = selectNextEpisodeFile(playableEpisodes, recent.episode.id, (episode) => filesByEpisode.get(episode.id) ?? []);
		if (nextEpisode) {
			return { type: "next_episode", mediaFileId: nextEpisode.id };
		}
	}

	const firstUnwatched = playableEpisodes.find((episode) => !watchedEpisodeIds.has(episode.id));
	if (firstUnwatched) {
		const mediaFile = selectPreferredMediaFile(filesByEpisode.get(firstUnwatched.id) ?? []);
		if (mediaFile) {
			return { type: watchedEpisodeIds.size > 0 ? "next_episode" : "new", mediaFileId: mediaFile.id };
		}
	}

	const firstEpisode = playableEpisodes[0];
	if (!firstEpisode) return undefined;

	const firstFile = selectPreferredMediaFile(filesByEpisode.get(firstEpisode.id) ?? []);

	return firstFile ? { type: "new", mediaFileId: firstFile.id } : undefined;
}

/** The "continue" suggestion for a partially watched episode. */
function continueSuggestion(progress: PlaybackProgress): SmartPlaySuggestion | undefined {
	if (progress.completed || progress.position <= 0) return undefined;

	return {
		type: "continue",
		mediaFileId: progress.mediaFileId,
		...(progress.audioStreamIndex === undefined ? {} : { audioStreamIndex: progress.audioStreamIndex }),
		...(progress.subtitleId === undefined ? {} : { subtitleId: progress.subtitleId }),
	};
}

export function compareEpisodes(
	left: { seasonNumber: number; episodeNumber: number; absoluteNumber?: number | null },
	right: { seasonNumber: number; episodeNumber: number; absoluteNumber?: number | null },
	useAbsolute: boolean,
): number {
	if (useAbsolute) {
		// Absolute (anime) ordering; episodes without a number sort last.
		const leftAbsolute = left.absoluteNumber ?? Number.MAX_SAFE_INTEGER;
		const rightAbsolute = right.absoluteNumber ?? Number.MAX_SAFE_INTEGER;
		if (leftAbsolute !== rightAbsolute) return leftAbsolute - rightAbsolute;
	}

	return left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber;
}
