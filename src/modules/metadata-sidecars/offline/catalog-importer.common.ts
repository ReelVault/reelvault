import type { Database } from "bun:sqlite";
import { metadataSidecarsService } from "../metadata-sidecars.service";
import type { CanonicalSidecarDocument, SidecarDocumentReader } from "../sidecar.types";

export interface CatalogImporterDependencies {
	readSidecarDocument: SidecarDocumentReader;
}

export const defaultCatalogImporterDependencies: CatalogImporterDependencies = {
	readSidecarDocument: (path) => metadataSidecarsService.readDocument(path),
};

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
