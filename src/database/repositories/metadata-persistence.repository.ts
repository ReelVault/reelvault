import type { ExternalIdentifiers, ProviderEpisodeResult, ProviderMetadataResult, ProviderSeasonResult } from "@reelvault/sdk/plugin";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { collectionRepository } from "@/database/repositories/collections.repository";
import { companiesRepository } from "@/database/repositories/companies.repository";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { genreRepository } from "@/database/repositories/genres.repository";
import { keywordsRepository } from "@/database/repositories/keywords.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { metadataExternalIdsRepository } from "@/database/repositories/metadata-external-ids.repository";
import { peopleRepository } from "@/database/repositories/people.repository";
import { providersRepository } from "@/database/repositories/providers.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";
import { createProviderStableKey } from "@/database/utils/stable-key";
import { clamp, isValidRating } from "@/utils/math.utils";

class MetadataPersistenceRepository {
	async createProviderMetadata({
		type,
		providerName,
		providers,
		metadata,
		matchScore,
	}: {
		type: "movie" | "tv_show";
		providerName: string;
		providers?: ReadonlyArray<{ providerId: string; externalId: string }> | undefined;
		metadata: ProviderMetadataResult;
		matchScore?: number | undefined;
	}) {
		return await databaseFactory.transaction(async (tx) => {
			const metadataResult = await metadataRepository.findOrCreateMetadata({
				type,
				results: metadata,
				providerName,
				providers: providers?.map((provider) => ({ name: provider.providerId, externalId: provider.externalId })),
				matchScore,
				tx,
			});
			const personImages = metadataResult.created
				? await this.createMetadataRelations(metadataResult.metadata.id, providerName, metadata, tx)
				: [];

			return { ...metadataResult, personImages };
		});
	}

	async rematchProviderMetadata({
		metadataId,
		type,
		providerName,
		metadata,
		matchScore,
	}: {
		metadataId: string;
		type: "movie" | "tv_show";
		providerName: string;
		metadata: ProviderMetadataResult;
		matchScore?: number | undefined;
	}) {
		return await databaseFactory.transaction(async (tx) => {
			const stableKey = createProviderStableKey({ providerName, entityType: type, externalId: metadata.externalId });

			const conflicting = await tx
				.select({ id: schema.metadata.id })
				.from(schema.metadata)
				.where(
					and(
						ne(schema.metadata.id, metadataId),
						or(
							and(
								eq(schema.metadata.title, metadata.title),
								eq(schema.metadata.type, type),
								eq(schema.metadata.releaseDate, metadata.releaseDate),
							),
							eq(schema.metadata.stableKey, stableKey),
						),
					),
				);

			if (conflicting.length > 0) {
				const conflictingIds = conflicting.map((c) => c.id);
				await tx.update(schema.mediaFiles).set({ metadataId }).where(inArray(schema.mediaFiles.metadataId, conflictingIds));

				await tx.delete(schema.metadata).where(inArray(schema.metadata.id, conflictingIds));
			}

			await metadataRepository.update({
				where: eq(schema.metadata.id, metadataId),
				values: {
					stableKey,
					primaryProviderId: providerName,
					title: metadata.title,
					originalTitle: metadata.originalTitle,
					overview: metadata.overview,
					tagline: metadata.tagline,
					releaseDate: metadata.releaseDate,
					status: metadata.status,
					popularity: metadata.popularity ?? 0,
					budget: metadata.budget,
					revenue: metadata.revenue,
					matchScore: matchScore ?? 1.0,
					hasMissingTranslation: metadata.hasMissingTranslation ?? false,
					updatedAt: new Date(),
				},
				tx,
			});

			await metadataExternalIdsRepository.replace(metadataId, { [providerName]: metadata.externalId }, tx);

			await metadataRepository.deleteProviders({ where: eq(schema.metadataProviders.metadataId, metadataId), tx });
			const provider = await providersRepository.findOrCreateByIdentity({
				name: providerName,
				externalId: metadata.externalId,
				entityType: type,
				tx,
			});
			if (provider) {
				await metadataRepository.insertProviders({ values: { metadataId, providerId: provider.id }, tx });
			}

			await Promise.all([
				metadataRepository.deleteCast({ where: eq(schema.metadataCast.metadataId, metadataId), tx }),
				metadataRepository.deleteCrew({ where: eq(schema.metadataCrew.metadataId, metadataId), tx }),
				metadataRepository.deleteGenres({ where: eq(schema.metadataGenres.metadataId, metadataId), tx }),
				metadataRepository.deleteKeywords({ where: eq(schema.metadataKeywords.metadataId, metadataId), tx }),
				metadataRepository.deleteCompanies({ where: eq(schema.metadataCompanies.metadataId, metadataId), tx }),
				metadataRepository.deleteCollections({ where: eq(schema.metadataCollections.metadataId, metadataId), tx }),
				metadataRepository.deleteRatings({ where: eq(schema.metadataRatings.metadataId, metadataId), tx }),
			]);

			const personImages = await this.createMetadataRelations(metadataId, providerName, metadata, tx);

			return { personImages };
		});
	}

	async syncCredits(
		metadataId: string,
		providerName: string,
		metadata: ProviderMetadataResult,
		lockedFields?: readonly string[],
	): Promise<Array<{ personId: string; url: string }>> {
		const lockedSet = new Set(lockedFields ?? []);
		const isCastLocked = lockedSet.has("cast");
		const isCrewLocked = lockedSet.has("crew");

		if (isCastLocked && isCrewLocked) {
			return [];
		}

		return await databaseFactory.transaction(async (tx) => {
			const deletes: Array<Promise<unknown>> = [];
			if (!isCastLocked) {
				deletes.push(metadataRepository.deleteCast({ where: eq(schema.metadataCast.metadataId, metadataId), tx }));
			}

			if (!isCrewLocked) {
				deletes.push(metadataRepository.deleteCrew({ where: eq(schema.metadataCrew.metadataId, metadataId), tx }));
			}

			await Promise.all(deletes);

			return await peopleRepository.processMetadataCredits({
				metadataId,
				providerName,
				cast: isCastLocked ? undefined : metadata.cast,
				crew: isCrewLocked ? undefined : metadata.crew,
				tx,
			});
		});
	}

	async syncMetadataRelations(
		metadataId: string,
		providerName: string,
		metadata: ProviderMetadataResult,
		lockedFields?: readonly string[],
	): Promise<void> {
		const lockedSet = new Set(lockedFields ?? []);
		const isGenresLocked = lockedSet.has("genres");
		const isKeywordsLocked = lockedSet.has("keywords");
		const isCompaniesLocked = lockedSet.has("companies") || lockedSet.has("studios");
		const isCollectionsLocked = lockedSet.has("collections");
		const isRatingsLocked = lockedSet.has("ratings");

		await databaseFactory.transaction(async (tx) => {
			const deletes: Array<Promise<unknown>> = [];
			if (!isGenresLocked) {
				deletes.push(metadataRepository.deleteGenres({ where: eq(schema.metadataGenres.metadataId, metadataId), tx }));
			}

			if (!isKeywordsLocked) {
				deletes.push(metadataRepository.deleteKeywords({ where: eq(schema.metadataKeywords.metadataId, metadataId), tx }));
			}

			if (!isCompaniesLocked) {
				deletes.push(metadataRepository.deleteCompanies({ where: eq(schema.metadataCompanies.metadataId, metadataId), tx }));
			}

			if (!isCollectionsLocked) {
				deletes.push(metadataRepository.deleteCollections({ where: eq(schema.metadataCollections.metadataId, metadataId), tx }));
			}

			if (!isRatingsLocked) {
				deletes.push(metadataRepository.deleteRatings({ where: eq(schema.metadataRatings.metadataId, metadataId), tx }));
			}

			await Promise.all(deletes);

			const processes: Array<Promise<unknown>> = [];
			if (!isGenresLocked) {
				processes.push(genreRepository.process({ metadataId, providerName, providerGenres: metadata.genres, tx }));
			}

			if (!isKeywordsLocked) {
				processes.push(keywordsRepository.process({ metadataId, providerName, keywordNames: metadata.keywords, tx }));
			}

			if (!isCompaniesLocked) {
				processes.push(companiesRepository.process({ metadataId, providerName, providerCompanies: metadata.productionCompanies, tx }));
			}

			if (!isCollectionsLocked) {
				processes.push(collectionRepository.process({ metadataId, providerName, collections: metadata.collection, tx }));
			}

			if (!isRatingsLocked) {
				processes.push(metadataRepository.insertRatings({ values: toRatingRows(metadataId, providerName, metadata), tx }));
			}

			await Promise.all(processes);
		});
	}

	async replaceExternalIds(metadataId: string, identifiers: ExternalIdentifiers) {
		await metadataExternalIdsRepository.replace(metadataId, identifiers);
	}

	/** Links an additional provider to an existing metadata entry without replacing the current primary provider. */
	async linkProvider(metadataId: string, type: "movie" | "tv_show", providerName: string, externalId: string): Promise<void> {
		await metadataRepository.linkProviders(metadataId, type, [{ name: providerName, externalId }]);
	}

	async createSeasonAndEpisode({
		metadataId,
		metadataStableKey,
		seasonInfo,
		episodeInfo,
		tx: parentTx,
	}: {
		metadataId: string;
		metadataStableKey?: string | null | undefined;
		seasonInfo: ProviderSeasonResult;
		episodeInfo?: ProviderEpisodeResult | undefined;
		tx?: DatabaseTransaction | undefined;
	}) {
		const runner = async (tx: DatabaseTransaction) => {
			const season = await seasonsRepository.findOrCreateByIdentity({
				metadataId,
				seasonNumber: Number(seasonInfo.seasonNumber),
				metadataStableKey,
				values: {
					metadataId,
					seasonNumber: Number(seasonInfo.seasonNumber),
					name: seasonInfo.name,
					overview: seasonInfo.overview,
					airDate: seasonInfo.airDate,
					status: seasonInfo.status,
				},
				tx,
			});

			return season
				? {
						season,
						episode: episodeInfo
							? await episodesRepository.findOrCreateByIdentity({
									seasonId: season.id,
									episodeNumber: Number(episodeInfo.episodeNumber),
									seasonStableKey: season.stableKey,
									values: {
										seasonId: season.id,
										episodeNumber: Number(episodeInfo.episodeNumber),
										absoluteNumber: episodeInfo.absoluteNumber !== undefined ? Number(episodeInfo.absoluteNumber) : null,
										title: episodeInfo.name,
										overview: episodeInfo.overview,
										airDate: episodeInfo.airDate,
									},
									tx,
								})
							: undefined,
					}
				: undefined;
		};

		return parentTx ? await runner(parentTx) : await databaseFactory.transaction(runner);
	}

	private async createMetadataRelations(
		metadataId: string,
		providerName: string,
		metadata: ProviderMetadataResult,
		tx: DatabaseTransaction,
	) {
		const [, , , , personImages] = await Promise.all([
			collectionRepository.process({ metadataId, providerName, collections: metadata.collection, tx }),
			companiesRepository.process({ metadataId, providerName, providerCompanies: metadata.productionCompanies, tx }),
			genreRepository.process({ metadataId, providerName, providerGenres: metadata.genres, tx }),
			keywordsRepository.process({ metadataId, providerName, keywordNames: metadata.keywords, tx }),
			peopleRepository.processMetadataCredits({
				metadataId,
				providerName,
				cast: metadata.cast,
				crew: metadata.crew,
				tx,
			}),
			metadataRepository.insertRatings({ values: toRatingRows(metadataId, providerName, metadata), tx }),
		]);

		return personImages;
	}
}

/**
 * Maps a provider result to `metadata_ratings` rows. Providers may expose many
 * ratings at once (e.g. OMDb → IMDb / Rotten Tomatoes / Metacritic); when only
 * the legacy `voteAverage`/`voteCount` pair is present a single rating is
 * synthesized under the provider's own id. Values are clamped to `[0, maxValue]`
 * to satisfy the table check constraint.
 */
function toRatingRows(metadataId: string, providerName: string, metadata: ProviderMetadataResult) {
	let ratings = metadata.ratings && metadata.ratings.length > 0 ? metadata.ratings : [];
	if (ratings.length === 0 && metadata.voteAverage !== undefined) {
		ratings = [{ source: providerName, value: metadata.voteAverage, maxValue: 10, votes: metadata.voteCount }];
	}

	return ratings
		.filter((rating) => isValidRating(rating))
		.map((rating) => {
			const maxValue = rating.maxValue && rating.maxValue > 0 ? rating.maxValue : 10;

			return {
				metadataId,
				source: rating.source.trim(),
				label: rating.label,
				value: clamp(rating.value, 0, maxValue),
				maxValue,
				votes: rating.votes && rating.votes > 0 ? Math.round(rating.votes) : 0,
				url: rating.url,
			};
		});
}

export const metadataPersistenceRepository = new MetadataPersistenceRepository();
