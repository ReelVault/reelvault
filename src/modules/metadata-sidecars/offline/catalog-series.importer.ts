import type { Database } from "bun:sqlite";
import { basename, dirname } from "node:path";
import type { OfflineRebuildIssue } from "@/modules/metadata-sidecars/offline-rebuild.types";
import { isVideoFile } from "@/utils/path.utils";
import { parseEpisode } from "./catalog-episode.parser";
import { CatalogImporter, type CollectImportDocumentsOptions, insertMetadataRow } from "./catalog-importer.utils";
import { type CatalogDirectoryNode, findDocumentsByNames, findMatchingFiles } from "./catalog-tree.walker";

/** Two files that name the same season and episode: the first one is imported, the rest are recorded. */
const DUPLICATE_EPISODE_REASON = "season and episode number already imported; file skipped";

function hasEpisodeNumber(database: Database, seasonId: string, episodeNumber: number): boolean {
	return (
		database
			.query<{ id: string }, [string, number]>(
				"SELECT id FROM episodes WHERE season_id = ? AND type = 'regular' AND episode_number = ? LIMIT 1",
			)
			.get(seasonId, episodeNumber) !== null
	);
}

export class CatalogSeriesImporter extends CatalogImporter {
	protected buildImportOptions(
		database: Database,
		libraryId: string,
		root: string,
		tree: ReadonlyMap<string, CatalogDirectoryNode>,
		skipped: OfflineRebuildIssue[],
	): CollectImportDocumentsOptions {
		const documents = findDocumentsByNames(tree, root, ["tvshow.nfo", "tvshow.reelvault.nfo"]);

		return {
			documents,
			mediaKind: "series",
			skipReason: "unsupported or invalid series sidecar",
			skipped,
			importDocument: (documentPath, document, now) => {
				const metadataId = crypto.randomUUID();
				const seriesDirectory = dirname(documentPath);
				insertMetadataRow(database, { id: metadataId, type: "tv_show", document, now });
				let mediaFiles = 0;
				for (const videoPath of findMatchingFiles(tree, seriesDirectory, (path) => isVideoFile(path))) {
					const episode = parseEpisode(basename(videoPath));
					if (!episode) continue;

					const seasonId = `${metadataId}-${episode.season}`;
					database.run(
						"INSERT OR IGNORE INTO seasons (id, stable_key, metadata_id, season_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
						[seasonId, seasonId, metadataId, episode.season, now, now],
					);
					if (hasEpisodeNumber(database, seasonId, episode.number)) {
						skipped.push({ path: videoPath, reason: DUPLICATE_EPISODE_REASON });
						continue;
					}
					const episodeId = crypto.randomUUID();
					database.run(
						"INSERT INTO episodes (id, stable_key, season_id, type, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, 'regular', ?, ?, ?, ?)",
						[episodeId, episodeId, seasonId, episode.number, basename(videoPath), now, now],
					);
					database.run(
						"INSERT INTO media_files (id, library_id, metadata_id, episode_id, file_path, file_name, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
						[crypto.randomUUID(), libraryId, metadataId, episodeId, videoPath, basename(videoPath), now, now],
					);
					mediaFiles++;
				}

				return mediaFiles;
			},
		};
	}
}
