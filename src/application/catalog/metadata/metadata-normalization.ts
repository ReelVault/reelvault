import type { MetadataCandidate } from "@sdk/common";
import type { ProviderMetadataResult } from "@sdk/plugin";
import { toMap } from "@/utils/array.utils";
import { ValidationError } from "@/utils/errors";

export function toMetadataCandidate(type: "movie" | "tv_show", providerId: string, metadata: ProviderMetadataResult): MetadataCandidate {
	const artwork: MetadataCandidate["artwork"] = [];
	if (metadata.posterPath) artwork.push({ kind: "poster", url: metadata.posterPath });

	if (metadata.backdropPath) artwork.push({ kind: "backdrop", url: metadata.backdropPath });

	if (metadata.logoPath) artwork.push({ kind: "logo", url: metadata.logoPath });

	return {
		type,
		identity: { providerId, entityType: type, externalId: metadata.externalId },
		title: metadata.title,
		originalTitle: metadata.originalTitle,
		overview: metadata.overview,
		tagline: metadata.tagline,
		releaseDate: metadata.releaseDate,
		artwork,
	};
}

export function applyMetadataCandidate(
	type: "movie" | "tv_show",
	providerId: string,
	original: ProviderMetadataResult,
	candidate: MetadataCandidate,
): ProviderMetadataResult {
	validateMetadataCandidate(type, providerId, original.externalId, candidate);

	const artwork = toMap(
		candidate.artwork,
		(item) => item.kind,
		(item) => item.url,
	);

	return {
		...original,
		title: candidate.title,
		originalTitle: candidate.originalTitle,
		overview: candidate.overview,
		tagline: candidate.tagline,
		releaseDate: candidate.releaseDate ?? original.releaseDate,
		posterPath: artwork.get("poster"),
		backdropPath: artwork.get("backdrop"),
		logoPath: artwork.get("logo"),
	};
}

function validateMetadataCandidate(type: "movie" | "tv_show", providerId: string, externalId: string, candidate: MetadataCandidate): void {
	if (candidate.type !== type || candidate.identity.providerId !== providerId || candidate.identity.externalId !== externalId) {
		throw new ValidationError("beforeMetadataSave cannot change the metadata identity", { code: "metadata.identity_change" });
	}

	if (candidate.identity.entityType !== type || !candidate.title.trim()) {
		throw new ValidationError("beforeMetadataSave returned an invalid metadata candidate", { code: "metadata.invalid_candidate" });
	}

	for (const artwork of candidate.artwork) {
		if (!artwork.url.trim())
			throw new ValidationError("beforeMetadataSave returned artwork without a URL", { code: "metadata.artwork_without_url" });
	}
}
