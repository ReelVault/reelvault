import type { Database } from "bun:sqlite";
import { metadataSidecarsService } from "../metadata-sidecars.service";
import type { CatalogImportResult, OfflineRebuildIssue } from "../offline-rebuild-report";
import type { CanonicalSidecarDocument, SidecarDocumentReader } from "../sidecar.types";

export interface CatalogImporterDependencies {
	readSidecarDocument: SidecarDocumentReader;
}

export const defaultCatalogImporterDependencies: CatalogImporterDependencies = {
	readSidecarDocument: (path) => metadataSidecarsService.readDocument(path),
};

export interface CollectImportDocumentsOptions {
	readonly documents: readonly string[];
	readonly mediaKind: "movie" | "series";
	readonly skipReason: string;
	readonly skipped: OfflineRebuildIssue[];
	/** Persists one valid document; returns the number of media files it claimed. */
	readonly importDocument: (documentPath: string, document: CanonicalSidecarDocument, now: number) => number;
}

/**
 * Shared import loop: reads and validates every candidate sidecar, records
 * invalid ones as skipped, and counts entries/media files. The per-kind insert
 * work lives in the `importDocument` callback.
 */
export async function collectImportDocuments(
	dependencies: CatalogImporterDependencies,
	options: CollectImportDocumentsOptions,
): Promise<CatalogImportResult> {
	let entries = 0;
	let mediaFiles = 0;
	for (const documentPath of options.documents) {
		const document = await dependencies.readSidecarDocument(documentPath);
		if (document?.mediaKind !== options.mediaKind || !document.title) {
			options.skipped.push({ path: documentPath, reason: options.skipReason });
			continue;
		}

		mediaFiles += options.importDocument(documentPath, document, Date.now());
		entries++;
	}

	return { entries, mediaFiles };
}

/** Metadata row shared by the movie and series offline catalog importers. */
export function insertMetadataRow(
	database: Database,
	{ id, type, document, now }: { id: string; type: "movie" | "tv_show"; document: CanonicalSidecarDocument; now: number },
): void {
	database.run(
		"INSERT INTO metadata (id, stable_key, title, original_title, overview, tagline, type, status, release_date, popularity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
		[
			id,
			id,
			document.title ?? null,
			document.originalTitle ?? null,
			document.overview ?? null,
			document.tagline ?? null,
			type,
			document.status ?? null,
			document.releaseDate ?? `${document.year ?? 0}-01-01`,
			now,
			now,
		],
	);
}
