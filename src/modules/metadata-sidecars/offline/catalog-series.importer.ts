import type { Database } from "bun:sqlite";
import { PathUtils } from "@/utils/path.utils";
import type { CatalogImportResult, OfflineRebuildIssue } from "../offline-rebuild-report";
import { parseEpisode } from "./catalog-episode.parser";
import { type CatalogImporterDependencies, defaultCatalogImporterDependencies, insertMetadataRow } from "./catalog-importer.common";
import { type CatalogDirectoryNode, findMatchingFiles } from "./catalog-tree.walker";

export class CatalogSeriesImporter {
	private readonly dependencies: CatalogImporterDependencies;

	constructor(dependencies: CatalogImporterDependencies = defaultCatalogImporterDependencies) {
		this.dependencies = dependencies;
	}

	async import(
		database: Database,
		libraryId: string,
		root: string,
		tree: ReadonlyMap<string, CatalogDirectoryNode>,
		skipped: OfflineRebuildIssue[],
	): Promise<CatalogImportResult> {
		const documents = findMatchingFiles(tree, root, (path) => {
			const name = PathUtils.getFileName(path).toLowerCase();

			return name === "tvshow.nfo" || name === "tvshow.reelvault.nfo";
		});
		let entries = 0;
		let mediaFiles = 0;
		for (const documentPath of documents) {
			const document = await this.dependencies.readSidecarDocument(documentPath);
			if (document?.mediaKind !== "series" || !document.title) {
				skipped.push({ path: documentPath, reason: "unsupported or invalid series sidecar" });
				continue;
			}

			const now = Date.now();
			const metadataId = crypto.randomUUID();
			const seriesDirectory = PathUtils.getDirName(documentPath);
			insertMetadataRow(database, { id: metadataId, type: "tv_show", document, now });
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

			entries++;
		}

		return { entries, mediaFiles };
	}
}
