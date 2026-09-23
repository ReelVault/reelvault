/** A media type supported by ReelVault metadata providers. */
export type CatalogMediaType = "movie" | "tv_show";

/** A catalog element kind used by title parsing and identity matching. */
export type MediaType = CatalogMediaType | "episode";

export interface MediaIdentity {
	title: string;
	type: MediaType;
	year?: number | undefined;
	season?: number | undefined;
	episode?: number | undefined;
}

/** Stable external identifier owned by a metadata provider. */
export interface ExternalIdentity {
	providerId: string;
	entityType: CatalogMediaType | "season" | "episode" | "person" | "collection";
	externalId: string;
}

/** Minimal media representation that is safe to expose outside the core. */
export interface MediaItem {
	id: string;
	type: CatalogMediaType | "episode";
	title: string;
	year?: number | undefined;
	externalIds: ExternalIdentity[];
}

/**
 * A file associated with a media item, as exposed to plugins. Paths are
 * intentionally never public. Named `PluginMediaFile` to stay distinct from the
 * full media-file entity (`MediaFile` in `media-file.types.ts`).
 */
export interface PluginMediaFile {
	id: string;
	metadataId: string;
	fileName: string;
	filePath?: string | undefined;
	durationMs?: number | undefined;
	available: boolean;
}
