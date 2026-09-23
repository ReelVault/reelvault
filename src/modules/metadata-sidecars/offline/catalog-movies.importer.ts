import type { Database } from "bun:sqlite";
import { PathUtils } from "@/utils/path.utils";
import type { CatalogImportResult, OfflineRebuildIssue } from "../offline-rebuild-report";
import { type CatalogImporterDependencies, defaultCatalogImporterDependencies, insertMetadataRow } from "./catalog-importer.common";
import { type CatalogDirectoryNode, findMatchingFiles } from "./catalog-tree.walker";

export class CatalogMoviesImporter {
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

			return name === "movie.nfo" || name === "movie.reelvault.nfo";
		});
		let entries = 0;
		let mediaFiles = 0;
		for (const documentPath of documents) {
			const document = await this.dependencies.readSidecarDocument(documentPath);
			if (document?.mediaKind !== "movie" || !document.title) {
				skipped.push({ path: documentPath, reason: "unsupported or invalid movie sidecar" });
				continue;
			}

			const now = Date.now();
			const metadataId = crypto.randomUUID();
			const movieId = crypto.randomUUID();
			const directory = PathUtils.getDirName(documentPath);
			insertMetadataRow(database, { id: metadataId, type: "movie", document, now });
			database.run("INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
				movieId,
				movieId,
				metadataId,
				now,
				now,
			]);
			let fileIndex = 0;
			// Only videos sitting NEXT TO the movie.nfo belong to this movie — a
			// recursive scan would let one root-level sidecar claim every video in
			// the subtree (episode folders included).
			for (const videoPath of findMatchingFiles(tree, directory, (path) => PathUtils.isVideoFile(path), { recursive: false })) {
				const id = crypto.randomUUID();
				database.run(
					"INSERT INTO media_files (id, library_id, metadata_id, movie_id, file_path, file_name, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[id, libraryId, metadataId, movieId, videoPath, PathUtils.getFileName(videoPath), fileIndex === 0 ? 1 : 0, now, now],
				);
				fileIndex++;
				mediaFiles++;
			}

			entries++;
		}

		return { entries, mediaFiles };
	}
}
