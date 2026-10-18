import type { ExternalIdentifiers, ProviderEpisodeResult, ProviderMetadataResult, ProviderSeasonResult } from "@reelvault/sdk/plugin";
import { and, eq, ne, or } from "drizzle-orm";
import { collectionRepository } from "@/app/repositories/collections.repository";
import { companiesRepository } from "@/app/repositories/companies.repository";
import { episodesRepository } from "@/app/repositories/episodes.repository";
import { genreRepository } from "@/app/repositories/genres.repository";
import { keywordsRepository } from "@/app/repositories/keywords.repository";
import { metadataRepository } from "@/app/repositories/metadata.repository";
import { metadataExternalIdsRepository } from "@/app/repositories/metadata-external-ids.repository";
import { metadataMergeRepository } from "@/app/repositories/metadata-merge.repository";
import { peopleRepository } from "@/app/repositories/people.repository";
import { providersRepository } from "@/app/repositories/providers.repository";
import { seasonsRepository } from "@/app/repositories/seasons.repository";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";
import { toMetadataValues } from "@/integrations/drizzle-orm/utils/metadata-values.mapper";
import { createProviderStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";
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
		return await databaseFactory.transaction(
			async (tx) => {
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
			},
			{ immediate: true },
		);
	}

	async rematchProviderMetadata({
		metadataId,
		type,
		providerName,
		metadata,
		matchScore,
		lockedFields,
	}: {
		metadataId: string;
		type: "movie" | "tv_show";
		providerName: string;
		metadata: ProviderMetadataResult;
		matchScore?: number | undefined;
		/** Locked fields keep their stored values and relation rows. */
		lockedFields?: readonly string[] | undefined;
	}) {
		const locked = new Set(lockedFields ?? []);
		return await databaseFactory.transaction(
			async (tx) => {
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
					// Route every conflict through the merge path: it repoints movie/
					// episode ids BEFORE deleting the duplicate metadata, so the FK
					// cascade cannot delete the just-repointed media files (and their
					// progress/history/markers) along with the duplicate's movie row.
					for (const conflict of conflicting) {
						await metadataMergeRepository.merge(metadataId, conflict.id, type);
					}
				}

				await metadataRepository.update({
					where: eq(schema.metadata.id, metadataId),
					values: {
						stableKey,
						...toUnlockedMetadataValues(toMetadataValues(metadata, providerName, matchScore ?? 1.0), locked),
						popularity: metadata.popularity ?? 0,
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

				const relationDeletes: Array<Promise<unknown>> = [];
				if (!locked.has("cast"))
					relationDeletes.push(metadataRepository.deleteCast({ where: eq(schema.metadataCast.metadataId, metadataId), tx }));
				if (!locked.has("crew"))
					relationDeletes.push(metadataRepository.deleteCrew({ where: eq(schema.metadataCrew.metadataId, metadataId), tx }));
				if (!locked.has("genres"))
					relationDeletes.push(metadataRepository.deleteGenres({ where: eq(schema.metadataGenres.metadataId, metadataId), tx }));
				if (!locked.has("keywords"))
					relationDeletes.push(metadataRepository.deleteKeywords({ where: eq(schema.metadataKeywords.metadataId, metadataId), tx }));
				if (!(locked.has("companies") || locked.has("studios")))
					relationDeletes.push(metadataRepository.deleteCompanies({ where: eq(schema.metadataCompanies.metadataId, metadataId), tx }));
				if (!locked.has("collections"))
					relationDeletes.push(metadataRepository.deleteCollections({ where: eq(schema.metadataCollections.metadataId, metadataId), tx }));
				if (!locked.has("ratings"))
					relationDeletes.push(metadataRepository.deleteRatings({ where: eq(schema.metadataRatings.metadataId, metadataId), tx }));
				await Promise.all(relationDeletes);

				const personImages = await this.createMetadataRelations(metadataId, providerName, metadata, tx, locked);

				return { personImages };
			},
			{ immediate: true },
		);
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
		flagMissingTranslation,
		tx: parentTx,
	}: {
		metadataId: string;
		metadataStableKey?: string | null | undefined;
		seasonInfo: ProviderSeasonResult;
		episodeInfo?: ProviderEpisodeResult | undefined;
		/** Series-level fallback-language flag — written in the same transaction (no standalone contended write). */
		flagMissingTranslation?: boolean | undefined;
		tx?: DatabaseTransaction | undefined;
	}) {
		return await runInTransaction(parentTx, async (tx) => {
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

			if (!season) return null;

			const episode = episodeInfo
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
				: null;

			if (flagMissingTranslation) await metadataRepository.flagMissingTranslation(metadataId, tx);

			return { season, ...(episode ? { episode } : {}) };
		});
	}

	private async createMetadataRelations(
		metadataId: string,
		providerName: string,
		metadata: ProviderMetadataResult,
		tx: DatabaseTransaction,
		locked: ReadonlySet<string> = new Set(),
	) {
		const [, , , , personImages] = await Promise.all([
			locked.has("collections")
				? Promise.resolve()
				: collectionRepository.process({ metadataId, providerName, collections: metadata.collection, tx }),
			locked.has("companies") || locked.has("studios")
				? Promise.resolve()
				: companiesRepository.process({ metadataId, providerName, providerCompanies: metadata.productionCompanies, tx }),
			locked.has("genres") ? Promise.resolve() : genreRepository.process({ metadataId, providerName, providerGenres: metadata.genres, tx }),
			locked.has("keywords")
				? Promise.resolve()
				: keywordsRepository.process({ metadataId, providerName, keywordNames: metadata.keywords, tx }),
			locked.has("cast") && locked.has("crew")
				? Promise.resolve([])
				: peopleRepository.processMetadataCredits({
						metadataId,
						providerName,
						cast: locked.has("cast") ? undefined : metadata.cast,
						crew: locked.has("crew") ? undefined : metadata.crew,
						tx,
					}),
			locked.has("ratings")
				? Promise.resolve()
				: metadataRepository.insertRatings({ values: toRatingRows(metadataId, providerName, metadata), tx }),
		]);

		return personImages;
	}
}

/** Scalar columns a field lock protects. An undefined column is skipped by the update, so its stored value stays. */
function toUnlockedMetadataValues(values: ReturnType<typeof toMetadataValues>, locked: ReadonlySet<string>) {
	return {
		...values,
		title: locked.has("title") ? undefined : values.title,
		originalTitle: locked.has("originalTitle") ? undefined : values.originalTitle,
		overview: locked.has("overview") ? undefined : values.overview,
		tagline: locked.has("tagline") ? undefined : values.tagline,
		releaseDate: locked.has("releaseDate") ? undefined : values.releaseDate,
		status: locked.has("status") ? undefined : values.status,
		budget: locked.has("budget") ? undefined : values.budget,
		revenue: locked.has("revenue") ? undefined : values.revenue,
	};
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
