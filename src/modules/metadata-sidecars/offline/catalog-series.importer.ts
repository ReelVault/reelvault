import type { Database } from "bun:sqlite";
import { PathUtils } from "@/utils/path.utils";
import type { OfflineRebuildIssue } from "../offline-rebuild-report";
import { parseEpisode } from "./catalog-episode.parser";
import { CatalogImporter, type CollectImportDocumentsOptions, insertMetadataRow } from "./catalog-importer.common";
import { type CatalogDirectoryNode, findDocumentsByNames, findMatchingFiles } from "./catalog-tree.walker";

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
				const seriesDirectory = PathUtils.getDirName(documentPath);
				insertMetadataRow(database, { id: metadataId, type: "tv_show", document, now });
				let mediaFiles = 0;
				for (const videoPath of findMatchingFiles(tree, seriesDirectory, (path) => PathUtils.isVideoFile(path))) {
					const episode = parseEpisode(PathUtils.getFileName(videoPath));
					if (!episode) continue;

					const seasonId = `${metadataId}-${episode.season}`;
					database.run(
						"INSERT OR IGNORE INTO seasons (id, stable_key, metadata_id, season_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
						[seasonId, seasonId, metadataId, episode.season, now, now],
					);
					const episodeId = crypto.randomUUID();
					database.run(
						"INSERT INTO episodes (id, stable_key, season_id, type, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, 'regular', ?, ?, ?, ?)",
						[episodeId, episodeId, seasonId, episode.number, PathUtils.getFileName(videoPath), now, now],
					);
					database.run(
						"INSERT INTO media_files (id, library_id, metadata_id, episode_id, file_path, file_name, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
						[crypto.randomUUID(), libraryId, metadataId, episodeId, videoPath, PathUtils.getFileName(videoPath), now, now],
					);
					mediaFiles++;
				}

				return mediaFiles;
			},
		};
	}
}
