import { groupBy } from "@/utils/array.utils";
import type { SmartPlaySuggestion } from "../streaming.types";
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

export function selectMovieSmartPlay(mediaFiles: readonly MediaFile[], progress?: PlaybackProgress): SmartPlaySuggestion | undefined {
	if (progress && !progress.completed && progress.position > 0 && mediaFiles.some((f) => f.id === progress.mediaFileId)) {
		return {
			type: "continue",
			mediaFileId: progress.mediaFileId,
			...(progress.audioStreamIndex !== undefined ? { audioStreamIndex: progress.audioStreamIndex } : {}),
			...(progress.subtitleId !== undefined ? { subtitleId: progress.subtitleId } : {}),
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
		const { episode: mostRecentEpisode, progress: mostRecentProgress } = recent;
		if (!mostRecentProgress.completed && mostRecentProgress.position > 0) {
			return {
				type: "continue",
				mediaFileId: mostRecentProgress.mediaFileId,
				...(mostRecentProgress.audioStreamIndex !== undefined ? { audioStreamIndex: mostRecentProgress.audioStreamIndex } : {}),
				...(mostRecentProgress.subtitleId !== undefined ? { subtitleId: mostRecentProgress.subtitleId } : {}),
			};
		}

		const nextEpisode = nextEpisodeAfter(playableEpisodes, mostRecentEpisode.id);
		if (nextEpisode) {
			const nextFile = selectPreferredMediaFile(filesByEpisode.get(nextEpisode.id) ?? []);
			if (nextFile) {
				return { type: "next_episode", mediaFileId: nextFile.id };
			}
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

function compareEpisodes(left: Episode, right: Episode, useAbsolute: boolean): number {
	if (useAbsolute) {
		// Absolute (anime) ordering; episodes without a number sort last.
		const leftAbsolute = left.absoluteNumber ?? Number.MAX_SAFE_INTEGER;
		const rightAbsolute = right.absoluteNumber ?? Number.MAX_SAFE_INTEGER;
		if (leftAbsolute !== rightAbsolute) return leftAbsolute - rightAbsolute;
	}

	return left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber;
}
