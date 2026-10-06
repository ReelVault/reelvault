import { selectNextEpisodeFile, selectPreferredMediaFile } from "@/modules/streaming/progress/smart-play";

/** Flat episode+file row returned by `episodesRepository.findEpisodesWithFilesByMetadataId`. */
export interface EpisodeWithFileRow {
	id: string;
	seasonId: string;
	seasonNumber: number;
	episodeNumber: number;
	mediaFileId: string | null;
	mediaFileIsDefault: boolean | null;
	mediaFileUpdatedAt: Date | null;
}

interface EpisodeEntry {
	id: string;
	seasonId: string;
	seasonNumber: number;
	files: Array<{ id: string; isDefault: boolean; updatedAt: Date }>;
}

/**
 * Next-episode file for the playback view: the immediate next episode in the
 * current season, else the first playable episode of each later season (in
 * season order). Rows are expected already ordered by (seasonNumber,
 * episodeNumber); the previous per-season scan semantics are preserved in one
 * pass. Episodes without files stay in the ordering so the immediate next
 * episode is still "no file" (which falls through to later seasons) rather than
 * skipping ahead within the season.
 */
export function resolveNextEpisodeFileId(rows: readonly EpisodeWithFileRow[], current: { id: string; seasonId: string }): string | null {
	const episodes: EpisodeEntry[] = [];
	const byId = new Map<string, EpisodeEntry>();
	for (const row of rows) {
		let entry = byId.get(row.id);
		if (!entry) {
			entry = { id: row.id, seasonId: row.seasonId, seasonNumber: row.seasonNumber, files: [] };
			byId.set(row.id, entry);
			episodes.push(entry);
		}

		if (row.mediaFileId && row.mediaFileUpdatedAt) {
			entry.files.push({ id: row.mediaFileId, isDefault: row.mediaFileIsDefault ?? false, updatedAt: row.mediaFileUpdatedAt });
		}
	}

	const nextFile = selectNextEpisodeFile(
		episodes.filter((episode) => episode.seasonId === current.seasonId),
		current.id,
		(next) => next.files,
	);
	if (nextFile) return nextFile.id;

	const currentSeasonNumber = episodes.find((episode) => episode.id === current.id)?.seasonNumber;
	if (currentSeasonNumber === undefined) return null;

	const episodesBySeason = new Map<number, EpisodeEntry[]>();
	for (const episode of episodes) {
		const seasonEpisodes = episodesBySeason.get(episode.seasonNumber);
		if (seasonEpisodes) seasonEpisodes.push(episode);
		else episodesBySeason.set(episode.seasonNumber, [episode]);
	}

	for (const seasonNumber of [...episodesBySeason.keys()].toSorted((left, right) => left - right)) {
		if (seasonNumber <= currentSeasonNumber) continue;

		const firstEpisode = episodesBySeason.get(seasonNumber)?.[0];
		const file = selectPreferredMediaFile(firstEpisode?.files ?? []);
		if (file) return file.id;
	}

	return null;
}
