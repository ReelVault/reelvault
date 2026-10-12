import type { MetadataPlaybackProgress, PlaybackProgressItem } from "@reelvault/sdk/common";
import { groupBy, toMap } from "@/utils/array.utils";
import type { PlaybackProgressComputeData, SmartPlay, SmartPlayComputeData } from "../streaming.types";
import { getPlaybackItemStatus } from "./playback-status";
import { selectEpisodeSmartPlay, selectMovieSmartPlay } from "./smart-play";

type ProgressByMediaFile = Map<string, PlaybackProgressItem>;

/** Saved progress for the given media files, skipping files that have none. */
function collectProgressItems(fileIds: Iterable<string>, progressByMediaFileId: ProgressByMediaFile): PlaybackProgressItem[] {
	const items: PlaybackProgressItem[] = [];
	for (const id of fileIds) {
		const item = progressByMediaFileId.get(id);
		if (item) items.push(item);
	}

	return items;
}

function seriesProgress(
	mediaFiles: PlaybackProgressComputeData["mediaFiles"],
	episodes: PlaybackProgressComputeData["episodes"],
	progressByMediaFileId: ProgressByMediaFile,
): Omit<MetadataPlaybackProgress, "fileProgress"> {
	const mediaFilesByEpisodeId = groupBy(
		mediaFiles,
		(mediaFile) => mediaFile.episodeId,
		(mediaFile) => mediaFile.id,
	);

	const episodeStatuses: MetadataPlaybackProgress["episodes"] = {};
	for (const episode of episodes) {
		const progress = collectProgressItems(mediaFilesByEpisodeId.get(episode.id) ?? [], progressByMediaFileId);
		episodeStatuses[episode.id] = getPlaybackItemStatus(progress);
	}

	let completedEpisodes = 0;
	let totalPlayable = 0;
	let hasProgress = false;
	for (const episode of episodes) {
		if ((episode.episodeType ?? "regular") !== "regular" || !mediaFilesByEpisodeId.has(episode.id)) continue;

		totalPlayable++;
		const st = episodeStatuses[episode.id]?.status;
		if (st === "watched") completedEpisodes++;

		if (st === "in_progress" || st === "watched") hasProgress = true;
	}

	let status: "in_progress" | "unwatched" | "watched";
	if (totalPlayable > 0 && completedEpisodes === totalPlayable) status = "watched";
	else if (hasProgress) status = "in_progress";
	else status = "unwatched";

	return {
		status,
		progress: null,
		completedEpisodes,
		totalEpisodes: totalPlayable,
		episodes: episodeStatuses,
	};
}

export function computePlaybackProgress(data: PlaybackProgressComputeData): MetadataPlaybackProgress {
	const { metadata, mediaFiles, progressRows, episodes } = data;

	const progressByMediaFileId: ProgressByMediaFile = new Map<string, PlaybackProgressItem>(
		progressRows.map((progress) => [
			progress.mediaFileId,
			{
				...progress,
				duration: progress.duration ?? 0,
				updatedAt: progress.updatedAt.toISOString(),
			},
		]),
	);

	// Per-file playback status keyed by mediaFileId — clients index into it
	// instead of re-deriving "which saved progress belongs to which file".
	const fileProgress: MetadataPlaybackProgress["fileProgress"] = Object.fromEntries(
		[...progressByMediaFileId].map(([fileId, item]) => [fileId, getPlaybackItemStatus([item])]),
	);

	if (metadata.type === "movie") {
		const movieFileIds = mediaFiles.filter((mf) => mf.movieId !== null).map((mf) => mf.id);

		return {
			...getPlaybackItemStatus(collectProgressItems(movieFileIds, progressByMediaFileId)),
			fileProgress,
			completedEpisodes: 0,
			totalEpisodes: 0,
			episodes: {},
		};
	}

	return { ...seriesProgress(mediaFiles, episodes, progressByMediaFileId), fileProgress };
}

export function computeSmartPlay(data: SmartPlayComputeData): SmartPlay {
	const { metadata, mediaFiles, progressRows, seasons = [], episodes } = data;
	const numberingMode = metadata.numberingMode ?? null;

	const normalizedMediaFiles = mediaFiles.map((mediaFile) => ({
		id: mediaFile.id,
		movieId: mediaFile.movieId,
		episodeId: mediaFile.episodeId,
		isDefault: mediaFile.isDefault ?? false,
		updatedAt: mediaFile.updatedAt ?? new Date(0),
	}));

	const normalizedProgressRows = progressRows.map((item) => ({
		...item,
		episodeId: item.episodeId ?? null,
	}));

	if (metadata.type === "movie") {
		const movieMediaFiles = normalizedMediaFiles.filter((mf) => mf.movieId !== null);
		const suggestion = selectMovieSmartPlay(movieMediaFiles, normalizedProgressRows[0]);

		return { suggestion: suggestion ?? null };
	}

	if (!seasons[0]) {
		return { suggestion: null };
	}

	const seasonNumberById = toMap(
		seasons,
		(season) => season.id,
		(season) => season.seasonNumber,
	);
	const watchedEpisodeIds = new Set<string>();
	for (const item of normalizedProgressRows) {
		if (item.completed && item.episodeId) watchedEpisodeIds.add(item.episodeId);
	}

	const regularEpisodes: Array<{ id: string; seasonId: string; episodeNumber: number; absoluteNumber: number | null }> = [];
	for (const ep of episodes) {
		if ((ep.episodeType ?? "regular") !== "regular" || !ep.seasonId || ep.episodeNumber === undefined) continue;

		regularEpisodes.push({
			id: ep.id,
			seasonId: ep.seasonId,
			episodeNumber: ep.episodeNumber,
			absoluteNumber: ep.absoluteNumber ?? null,
		});
	}

	const episodeSmartInput = regularEpisodes.map((episode) => ({
		id: episode.id,
		seasonNumber: seasonNumberById.get(episode.seasonId) ?? Number.MAX_SAFE_INTEGER,
		episodeNumber: episode.episodeNumber,
		absoluteNumber: episode.absoluteNumber,
	}));
	const suggestion = selectEpisodeSmartPlay(
		episodeSmartInput,
		normalizedMediaFiles,
		watchedEpisodeIds,
		normalizedProgressRows,
		numberingMode,
	);

	return { suggestion: suggestion ?? null };
}
