import type { SidecarFlavor } from "@sdk/common/library.types";
import type { ExternalIdentifiers } from "@sdk/plugin";

type SidecarMediaKind = "movie" | "series" | "season" | "episode";

/** Target dialect for written sidecars. Kodi's NFO format is the one Plex and
 * Jellyfin also read, so a single non-native flavor covers them all. */
export type { SidecarFlavor };

export interface SidecarArtworkReference {
	readonly path: string;
}

export interface SidecarArtwork {
	readonly poster?: SidecarArtworkReference | undefined;
	readonly backdrop?: SidecarArtworkReference | undefined;
	readonly thumbnail?: SidecarArtworkReference | undefined;
}

interface SidecarCastMember {
	readonly name: string;
	readonly character?: string | undefined;
	readonly order?: number | undefined;
}

interface SidecarCrewMember {
	readonly name: string;
	readonly job: string;
}

export interface SidecarRating {
	readonly source: string;
	readonly value: number;
	readonly voteCount?: number | undefined;
}

export interface CanonicalSidecarDocument {
	readonly mediaKind: SidecarMediaKind;
	readonly identifiers: ExternalIdentifiers;
	readonly title?: string | undefined;
	readonly originalTitle?: string | undefined;
	readonly year?: number | undefined;
	readonly releaseDate?: string | undefined;
	readonly overview?: string | undefined;
	readonly tagline?: string | undefined;
	readonly status?: string | undefined;
	readonly genres?: readonly string[] | undefined;
	readonly cast?: readonly SidecarCastMember[] | undefined;
	readonly ratings?: readonly SidecarRating[] | undefined;
	readonly runtimeMinutes?: number | undefined;
	readonly providerSnapshot?: unknown;
	readonly artwork: SidecarArtwork;
}

export interface SidecarSnapshotDocument {
	readonly reelvaultSchemaVersion: number;
	readonly title: string;
	readonly originalTitle?: string | undefined;
	readonly releaseDate?: string | undefined;
	readonly year?: number | undefined;
	readonly overview?: string | undefined;
	readonly tagline?: string | undefined;
	readonly status?: string | undefined;
	/** Season/episode placement — required by the Kodi dialect for `<season>` and `<episodedetails>`. */
	readonly seasonNumber?: number | undefined;
	readonly episodeNumber?: number | undefined;
	readonly identifiers: ExternalIdentifiers;
	readonly providerIds: Readonly<Record<string, string>>;
	readonly genres: readonly string[];
	readonly keywords: readonly string[];
	readonly collection?: string | undefined;
	readonly productionCompanies: readonly string[];
	readonly cast: readonly SidecarCastMember[];
	readonly crew: readonly SidecarCrewMember[];
	readonly ratings: readonly SidecarRating[];
}

export interface SidecarFormatInput {
	readonly documentPath: string;
	readonly content?: string | undefined;
}

export interface SidecarFormatOutput {
	readonly documentPath: string;
	readonly document: SidecarSnapshotDocument;
}

export interface SidecarWriteResult {
	readonly documentPath: string;
	readonly writtenFiles: readonly string[];
}

export interface SidecarSnapshotResolver {
	metadata(metadataId: string): Promise<SidecarSnapshotDocument>;
	season(seasonId: string): Promise<SidecarSnapshotDocument>;
	episode(episodeId: string): Promise<SidecarSnapshotDocument>;
}

export interface SidecarMetadataWriter {
	saveMovie(input: { metadataId: string; movieDirectory: string; flavor?: SidecarFlavor | undefined }): Promise<SidecarWriteResult>;
	saveSeries(input: { metadataId: string; seriesDirectory: string; flavor?: SidecarFlavor | undefined }): Promise<SidecarWriteResult>;
	saveSeason(input: {
		seasonId: string;
		seasonDirectory: string;
		seasonNumber: number;
		flavor?: SidecarFlavor | undefined;
		/** Prebuilt snapshot — spares the writer a re-fetch of the already-loaded row. */
		snapshot?: SidecarSnapshotDocument | undefined;
	}): Promise<SidecarWriteResult>;
	saveEpisode(input: {
		episodeId: string;
		episodeDirectory: string;
		videoBaseName: string;
		flavor?: SidecarFlavor | undefined;
		/** Prebuilt snapshot — spares the writer a re-fetch of the already-loaded row. */
		snapshot?: SidecarSnapshotDocument | undefined;
	}): Promise<SidecarWriteResult>;
}

export type SidecarDocumentReader = (documentPath: string) => Promise<CanonicalSidecarDocument | null>;
