import type { Database } from "bun:sqlite";
import { basename, dirname } from "node:path";
import type { OfflineRebuildIssue } from "@/modules/metadata-sidecars/offline-rebuild.types";
import { isVideoFile } from "@/utils/path.utils";
import { CatalogImporter, type CollectImportDocumentsOptions, insertMetadataRow } from "./catalog-importer.utils";
import { type CatalogDirectoryNode, findDocumentsByNames, findMatchingFiles } from "./catalog-tree.walker";

export class CatalogMoviesImporter extends CatalogImporter {
	protected buildImportOptions(
		database: Database,
		libraryId: string,
		root: string,
		tree: ReadonlyMap<string, CatalogDirectoryNode>,
		skipped: OfflineRebuildIssue[],
	): CollectImportDocumentsOptions {
		const documents = findDocumentsByNames(tree, root, ["movie.nfo", "movie.reelvault.nfo"]);

		return {
			documents,
			mediaKind: "movie",
			skipReason: "unsupported or invalid movie sidecar",
			skipped,
			importDocument: (documentPath, document, now) => {
				const metadataId = crypto.randomUUID();
				const movieId = crypto.randomUUID();
				const directory = dirname(documentPath);
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
				for (const videoPath of findMatchingFiles(tree, directory, (path) => isVideoFile(path), { recursive: false })) {
					const id = crypto.randomUUID();
					database.run(
						"INSERT INTO media_files (id, library_id, metadata_id, movie_id, file_path, file_name, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
						[id, libraryId, metadataId, movieId, videoPath, basename(videoPath), fileIndex === 0 ? 1 : 0, now, now],
					);
					fileIndex++;
				}

				return fileIndex;
			},
		};
	}
}
