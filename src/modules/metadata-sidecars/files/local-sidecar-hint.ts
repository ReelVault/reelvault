import type { ExternalIdentifiers } from "@sdk/plugin";
import { metadataSidecarsService } from "../metadata-sidecars.service";
import type { CanonicalSidecarDocument } from "../sidecar.types";
import { locateLocalNfoChain } from "./local-nfo-locator";

/**
 * Identity + descriptive payload distilled from the NFO documents next to a
 * video file. `posterPath`/`backdropPath`/season/episode artwork are LOCAL
 * absolute paths — the image pipeline accepts them alongside provider URLs.
 */
export interface SidecarMetadataHint {
	readonly identifiers: ExternalIdentifiers;
	readonly title?: string | undefined;
	readonly originalTitle?: string | undefined;
	readonly year?: number | undefined;
	readonly releaseDate?: string | undefined;
	readonly overview?: string | undefined;
	readonly posterPath?: string | undefined;
	readonly backdropPath?: string | undefined;
	readonly genres?: readonly string[] | undefined;
	readonly seasonName?: string | undefined;
	readonly seasonPosterPath?: string | undefined;
	readonly episodeName?: string | undefined;
	readonly episodeThumbnailPath?: string | undefined;
}

/**
 * Reads the NFO chain for a video file (sidecar-first import). Returns
 * undefined when the file has no sidecar documents — callers must fall back
 * to filename-parsed identity.
 */
export async function readSidecarMetadataHint(videoPath: string, kind: "movie" | "tv_show"): Promise<SidecarMetadataHint | undefined> {
	const chain = await locateLocalNfoChain(videoPath, kind);

	if (kind === "movie") {
		const document = chain.movieDocument ? await readDocument(chain.movieDocument) : undefined;
		if (!document) return undefined;

		return {
			identifiers: document.identifiers,
			title: document.title,
			originalTitle: document.originalTitle,
			year: document.year,
			releaseDate: document.releaseDate,
			overview: document.overview,
			posterPath: document.artwork.poster?.path,
			backdropPath: document.artwork.backdrop?.path,
			genres: document.genres,
		};
	}

	const [seriesDocument, seasonDocument, episodeDocument] = await Promise.all([
		chain.seriesDocument ? readDocument(chain.seriesDocument) : undefined,
		chain.seasonDocument ? readDocument(chain.seasonDocument) : undefined,
		chain.episodeDocument ? readDocument(chain.episodeDocument) : undefined,
	]);
	const primary = seriesDocument ?? seasonDocument;
	if (!(primary || episodeDocument)) return undefined;

	return {
		identifiers: primary?.identifiers ?? episodeDocument?.identifiers ?? {},
		title: primary?.title,
		originalTitle: primary?.originalTitle,
		year: primary?.year,
		releaseDate: primary?.releaseDate,
		overview: primary?.overview,
		posterPath: primary?.artwork.poster?.path,
		backdropPath: primary?.artwork.backdrop?.path,
		genres: primary?.genres,
		seasonName: seasonDocument?.title,
		seasonPosterPath: seasonDocument?.artwork.poster?.path,
		episodeName: episodeDocument?.title,
		episodeThumbnailPath: episodeDocument?.artwork.thumbnail?.path,
	};
}

async function readDocument(documentPath: string): Promise<CanonicalSidecarDocument | undefined> {
	return (await metadataSidecarsService.readDocument(documentPath)) ?? undefined;
}
