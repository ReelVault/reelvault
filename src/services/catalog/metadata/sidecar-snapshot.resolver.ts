import { parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import type { SidecarSnapshotDocument, SidecarSnapshotResolver } from "@/modules/metadata-sidecars/sidecar.types";
import { episodeSnapshot, seasonSnapshot } from "@/modules/metadata-sidecars/sidecar-snapshot.builder";
import { episodesRepository } from "@/repositories/episodes.repository";
import { metadataRepository } from "@/repositories/metadata.repository";
import { seasonsRepository } from "@/repositories/seasons.repository";
import { DomainError } from "@/utils/domain.errors";
import { extractYear } from "@/utils/media-match/normalize.utils";

export class DatabaseSidecarSnapshotResolver implements SidecarSnapshotResolver {
	async metadata(metadataId: string): Promise<SidecarSnapshotDocument> {
		const metadata = await metadataRepository.findById({
			primaryId: metadataId,
			fields: parseFields({
				fields: "title,originalTitle,releaseDate,overview,tagline,status,providers,genres,keywords,collections,companies,cast,crew,rating",
			}),
		});
		if (!metadata) throw new DomainError("not_found", `Metadata ${metadataId} does not exist`, { code: "metadata.not_found" });

		const providerIds = Object.fromEntries(metadata.providers.map((provider) => [provider.name, provider.externalId]));

		return {
			reelvaultSchemaVersion: 1,
			title: metadata.title,
			originalTitle: metadata.originalTitle ?? undefined,
			releaseDate: metadata.releaseDate,
			year: extractYear(metadata.releaseDate.slice(0, 4)),
			overview: metadata.overview ?? undefined,
			tagline: metadata.tagline ?? undefined,
			status: metadata.status ?? undefined,
			identifiers: providerIds,
			providerIds,
			genres: metadata.genres.map((genre) => genre.name),
			keywords: metadata.keywords.map((keyword) => keyword.name),
			collection: metadata.collections[0]?.name,
			productionCompanies: metadata.companies.map((company) => company.name),
			cast: metadata.cast.flatMap((member) =>
				member.data
					? [
							{
								name: member.data.name,
								character: member.character ?? undefined,
								order: member.sortOrder >= 0 ? member.sortOrder : undefined,
							},
						]
					: [],
			),
			crew: metadata.crew.flatMap((member) => (member.data ? [{ name: member.data.name, job: member.job }] : [])),
			ratings: metadata.rating.scores.map((rating) => ({ source: rating.source, value: rating.value, voteCount: rating.votes })),
		};
	}

	async season(seasonId: string): Promise<SidecarSnapshotDocument> {
		const season = await seasonsRepository.findByPrimaryId({
			primaryId: seasonId,
			fields: parseFields({ fields: "name,seasonNumber,airDate,overview,status" }),
		});
		if (!season) throw new DomainError("not_found", `Season ${seasonId} does not exist`, { code: "season.not_found" });

		return seasonSnapshot(season);
	}

	async episode(episodeId: string): Promise<SidecarSnapshotDocument> {
		const episode = await episodesRepository.findByPrimaryId({
			primaryId: episodeId,
			fields: parseFields({ fields: "title,episodeNumber,airDate,overview" }),
		});
		if (!episode) throw new DomainError("not_found", `Episode ${episodeId} does not exist`, { code: "episode.not_found" });

		return episodeSnapshot(episode);
	}
}
