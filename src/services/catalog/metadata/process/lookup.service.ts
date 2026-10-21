import type { MediaIdentity } from "@reelvault/sdk/common";
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import type { SidecarMetadataHint } from "@/modules/metadata-sidecars/files/local-sidecar.reader";
import type { AggregatedProviderLink } from "@/plugins/capabilities/metadata-aggregator.service";
import { episodesRepository } from "@/repositories/episodes.repository";
import { metadataRepository } from "@/repositories/metadata.repository";
import { seasonsRepository } from "@/repositories/seasons.repository";
import type { CreatedProviderMetadata } from "@/services/catalog/metadata/providers/metadata-create.utils";
import { normalizeForMatching } from "@/utils/release-tags.constants";
import type { TaskSchedulingOptions } from "@/utils/task-context.types";
import { ensureBaseMetadata } from "./base.service";
import { processTVShowMetadata } from "./entries.service";
import type { MetadataProcessResult, MetadataProcessState } from "./shared.types";

type LocalMetadata = Awaited<ReturnType<typeof metadataRepository.findByTitleAndType>>;

/** Deterministic slug for sidecar-derived external ids / genre ids. */
function slugify(value: string): string {
	return normalizeForMatching(value).replaceAll(" ", "-");
}

/** The existing row for this title, unless its release year contradicts the file's (e.g. a remake or sequel). */
export async function findExistingLocalMetadata(
	state: MetadataProcessState,
	type: "movie" | "tv_show",
	parsed: MediaIdentity,
): Promise<LocalMetadata | undefined> {
	try {
		// Existence probe run once per media file during scans — project the
		// four consumed columns or the default fetch fans out into the full
		// detail-page relation load per file.
		const exact = await metadataRepository.findByTitleAndType(type, parsed.title);
		if (!exact) return undefined;

		// If both the incoming file and the local record have a release year, verify they match (<= 1 year difference)
		if (parsed.year && exact.releaseDate) {
			const localYear = Number.parseInt(exact.releaseDate.slice(0, 4), 10);
			if (Number.isInteger(localYear) && Math.abs(localYear - parsed.year) > 1) {
				// Different year (e.g. Iron Man 2008 vs Iron Man remake/sequel) - let provider search find the correct one
				return undefined;
			}
		}

		return exact;
	} catch (error) {
		state.logger.debug("Failed to find existing local movie metadata", { type: parsed.type, title: parsed.title, error });

		return undefined;
	}
}

/**
 * Resolves an existing metadata row through the sidecar's external ids
 * (imdb/tmdb namespaces double as provider names in the providers table).
 */
export async function findMetadataByIdentifiers(
	type: "movie" | "tv_show",
	sidecar: SidecarMetadataHint,
): Promise<
	| {
			metadataId: string;
			stableKey: string | null;
			metadata: ProviderMetadataResult;
			providers: AggregatedProviderLink[];
	  }
	| undefined
> {
	for (const namespace of ["tmdb", "imdb"] as const) {
		const externalId = sidecar.identifiers[namespace];
		if (!externalId) continue;

		const [row] = await metadataRepository.findByProviderExternalIds({
			providerName: namespace,
			entityType: type,
			externalIds: [externalId],
		});
		if (!row) continue;

		return {
			metadataId: row.metadata.id,
			stableKey: row.metadata.stableKey,
			metadata: { externalId: row.externalId, title: row.metadata.title, releaseDate: row.metadata.releaseDate },
			providers: [{ providerId: namespace, externalId }],
		};
	}

	return undefined;
}

/**
 * Offline import: builds the metadata row from the NFO payload itself.
 * `providerName` records the id namespace (tmdb/imdb) or "sidecar"; the
 * provider link + stable key make rescans idempotent. Local artwork paths
 * ride on posterPath/backdropPath — the image pipeline accepts local files.
 */
export async function createSidecarMetadata(
	state: MetadataProcessState,
	type: "movie" | "tv_show",
	sidecar: SidecarMetadataHint,
): Promise<{ base: CreatedProviderMetadata; providers: AggregatedProviderLink[] } | undefined> {
	const title = sidecar.title;
	if (!title) return undefined;

	let identifier: { readonly providerId: "tmdb" | "imdb"; readonly externalId: string } | undefined;
	if (sidecar.identifiers.tmdb) {
		identifier = { providerId: "tmdb", externalId: sidecar.identifiers.tmdb };
	} else if (sidecar.identifiers.imdb) {
		identifier = { providerId: "imdb", externalId: sidecar.identifiers.imdb };
	}

	const externalId = identifier?.externalId ?? `nfo-${slugify(title)}${sidecar.year ? `-${sidecar.year}` : ""}`;
	state.logger.info("Importing metadata from local sidecar", { type, title, source: identifier?.providerId ?? "sidecar" });

	const providers = identifier ? [identifier] : [{ providerId: "sidecar", externalId }];
	const base = await ensureBaseMetadata(state, {
		type,
		providerName: identifier?.providerId ?? "sidecar",
		providerMetadata: {
			externalId,
			title,
			originalTitle: sidecar.originalTitle,
			overview: sidecar.overview,
			releaseDate: sidecar.releaseDate ?? (sidecar.year ? `${sidecar.year}-01-01` : ""),
			genres: sidecar.genres?.map((name) => ({ id: `nfo-genre-${slugify(name)}`, name })),
			posterPath: sidecar.posterPath,
			backdropPath: sidecar.backdropPath,
		},
		matchScore: 1,
		providers,
	});

	return { base, providers };
}

/** A local TV row: its season and episode when they exist, otherwise processed through its provider link. */
export async function resolveLocalTVShow(
	state: MetadataProcessState,
	input: {
		existing: { id: string; title: string; releaseDate: string | null; stableKey?: string | null };
		parsed: MediaIdentity;
		scheduling?: TaskSchedulingOptions | undefined;
		sidecarHint?: SidecarMetadataHint | undefined;
		language?: string | undefined;
	},
): Promise<MetadataProcessResult | undefined> {
	const { existing, parsed, scheduling, sidecarHint, language } = input;
	if (parsed.season === undefined) return undefined;

	try {
		const season = await seasonsRepository.findByMetadataAndNumber(existing.id, parsed.season);

		if (season && parsed.episode !== undefined) {
			const episode = await episodesRepository.findBySeasonAndNumber(season.id, parsed.episode);
			if (episode) {
				return { metadataId: existing.id, movieId: null, episodeId: episode.id };
			}
		}

		const providerLink = await metadataRepository.findFirstProviderLink(existing.id);

		if (providerLink) {
			const pseudoMetadata: ProviderMetadataResult = {
				externalId: providerLink.externalId,
				title: existing.title,
				releaseDate: existing.releaseDate ?? "",
			};

			return await processTVShowMetadata(state, existing.id, parsed, pseudoMetadata, {
				metadataStableKey: existing.stableKey,
				scheduling,
				providers: [{ providerId: providerLink.name, externalId: providerLink.externalId }],
				sidecarHint,
				language,
			});
		}
	} catch (error) {
		state.logger.debug("Failed to resolve local TV show", { externalId: existing.id, error });

		return undefined;
	}

	return undefined;
}
