/**
 * Keeps the most recently updated progress row per episode id. `keep` filters
 * rows before they compete (e.g. only rows pointing at a playable media file).
 */
export function latestProgressByEpisode<T extends { episodeId?: string | null | undefined; updatedAt?: Date | undefined }>(
	rows: readonly T[],
	keep?: (row: T, episodeId: string) => boolean,
): Map<string, T> {
	const byEpisode = new Map<string, T>();
	for (const row of rows) {
		const episodeId = row.episodeId;
		if (!episodeId) continue;

		if (keep && !keep(row, episodeId)) continue;

		const existing = byEpisode.get(episodeId);
		if (!existing || (row.updatedAt?.getTime() ?? 0) > (existing.updatedAt?.getTime() ?? 0)) {
			byEpisode.set(episodeId, row);
		}
	}

	return byEpisode;
}
