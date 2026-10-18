import type { FieldsQuery, MediaFileWithRelation, ReassignMediaFile, SelectFields } from "@reelvault/sdk/common";
import { recordAuditSafe } from "@/app/admin/admin-audit.service";
import { fallbackEpisodeExternalId, fallbackSeasonExternalId } from "@/app/catalog/catalog.utils";
import { resolveLibraryLanguage } from "@/app/catalog/metadata/providers/library-metadata-language.resolver";
import { createFromProvider, processPersonImages } from "@/app/catalog/metadata/providers/metadata-create.utils";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { episodesRepository } from "@/app/repositories/episodes.repository";
import { librariesRepository } from "@/app/repositories/libraries.repository";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { metadataRepository } from "@/app/repositories/metadata.repository";
import { metadataPersistenceRepository } from "@/app/repositories/metadata-persistence.repository";
import { moviesRepository } from "@/app/repositories/movies.repository";
import { seasonsRepository } from "@/app/repositories/seasons.repository";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { mapLibraryType } from "@/utils/type.utils";
import type { MediaServiceState } from "../shared.utils";

/**
 * Fetches provider details and persists a brand-new metadata record for a
 * reassign-by-provider request, then refreshes its artwork.
 */
async function createReassignMetadataFromProvider(
	providerId: string,
	externalId: string,
	mediaType: "movie" | "tv_show",
	libraryId: string,
): Promise<string> {
	const providerMetadata = await providerService.fetchDetailsByProvider(providerId, mediaType, externalId, {
		language: await resolveLibraryLanguage(libraryId),
	});
	if (!providerMetadata) {
		throw new DomainError("not_found", "Provider details not found", {
			code: "media_file.provider_details_not_found",
			params: { providerId },
		});
	}

	const result = await createFromProvider({
		type: mediaType,
		providerName: providerId,
		providerMetadata,
		matchScore: 1.0,
	});
	const targetMetadataId = result.metadataId;

	await imageProcessingService.replaceProviderArtwork(targetMetadataId, providerMetadata);
	await processPersonImages(result.personImages, ({ personId, url }) => imageProcessingService.processPerson(personId, url, true));

	pluginEventBus.publish("metadata.saved", { metadataId: targetMetadataId });

	return targetMetadataId;
}

/** Validates that an existing metadata target matches the media file's type. */
async function assertReassignTargetMetadata(targetMetadataId: string, mediaType: "movie" | "tv_show"): Promise<string> {
	const existingMetadata = await metadataRepository.findByIdForRead(targetMetadataId, {
		fields: "id,type,title",
	});
	assertFound(existingMetadata, "Metadata", targetMetadataId);
	if (existingMetadata.type !== mediaType) {
		throw new DomainError("validation", "Metadata type mismatch", {
			code: "media_file.metadata_type_mismatch",
			params: { expectedType: mediaType, actualType: existingMetadata.type },
		});
	}

	return existingMetadata.id;
}

/** Resolves the reassign target id from provider details or an existing metadata record. */
async function resolveReassignTarget(body: ReassignMediaFile, mediaType: "movie" | "tv_show", libraryId: string): Promise<string> {
	if (body.providerId && body.externalId) {
		return await createReassignMetadataFromProvider(body.providerId, body.externalId, mediaType, libraryId);
	}

	if (body.targetMetadataId) return await assertReassignTargetMetadata(body.targetMetadataId, mediaType);

	throw new DomainError("validation", "targetMetadataId or provider details are required", {
		code: "media_file.target_required",
	});
}

async function resolveMovieAnchor(targetMetadataId: string): Promise<string> {
	const movie = await moviesRepository.findOrCreateByMetadataId({ metadataId: targetMetadataId });
	if (!movie) throw new DomainError("internal", "Failed to create movie record", { code: "media_file.movie_create_failed" });

	return movie.id;
}

async function resolveEpisodeAnchorById(episodeId: string, targetMetadataId: string): Promise<string> {
	const episode = await episodesRepository.findByIdForRead(episodeId, {
		fields: "id,seasonId",
	});
	assertFound(episode, "Episode", episodeId);
	const season = await seasonsRepository.findByIdForRead(episode.seasonId, {
		fields: "id,metadataId",
	});
	if (!season || season.metadataId !== targetMetadataId) {
		throw new DomainError("validation", "Selected episode does not belong to the target series", {
			code: "media_file.episode_mismatch",
		});
	}

	return episode.id;
}

async function resolveEpisodeAnchorByNumbers(targetMetadataId: string, seasonNumber: number, episodeNumber: number): Promise<string> {
	const targetMeta = await metadataRepository.findByIdForRead(targetMetadataId, { fields: "id,stableKey" });
	const seasonInfo = {
		externalId: fallbackSeasonExternalId(targetMetadataId, seasonNumber),
		seasonNumber,
	};
	const episodeInfo = {
		externalId: fallbackEpisodeExternalId(targetMetadataId, seasonNumber, episodeNumber),
		seasonNumber,
		episodeNumber,
	};
	const persisted = await metadataPersistenceRepository.createSeasonAndEpisode({
		metadataId: targetMetadataId,
		metadataStableKey: targetMeta?.stableKey,
		seasonInfo,
		episodeInfo,
	});
	if (!persisted?.episode)
		throw new DomainError("internal", "Failed to create episode record", { code: "media_file.episode_create_failed" });

	return persisted.episode.id;
}

/** Anchors the media file to a movie record or a concrete episode of the target series. */
async function resolveReassignAnchor(
	mediaType: "movie" | "tv_show",
	body: ReassignMediaFile,
	targetMetadataId: string,
): Promise<{ movieId: string | null; episodeId: string | null }> {
	if (mediaType === "movie") return { movieId: await resolveMovieAnchor(targetMetadataId), episodeId: null };

	if (body.episodeId) return { movieId: null, episodeId: await resolveEpisodeAnchorById(body.episodeId, targetMetadataId) };

	if (body.seasonNumber !== undefined && body.episodeNumber !== undefined) {
		return {
			movieId: null,
			episodeId: await resolveEpisodeAnchorByNumbers(targetMetadataId, body.seasonNumber, body.episodeNumber),
		};
	}

	throw new DomainError("validation", "Episode selection required for a series", { code: "media_file.episode_required" });
}

export async function reassign<F extends string>(
	state: MediaServiceState,
	mediaFileId: string,
	body: ReassignMediaFile,
	query?: FieldsQuery<F>,
	context?: AdminAuditContext,
): Promise<SelectFields<MediaFileWithRelation, F>> {
	return await runSafely(state, "reassign", async () => {
		const mediaFile = await mediaRepository.findByIdForRead(mediaFileId, {
			fields: "id,libraryId,metadataId,movieId,episodeId,isDefault,filePath,fileName",
		});
		assertFound(mediaFile, "MediaFile", mediaFileId);

		// Only library.type is read here — the default fetch would run the
		// library stats/path aggregates for a single string comparison.
		const library = await librariesRepository.findByIdForRead(mediaFile.libraryId, { fields: "id,type" });
		if (!library) {
			throw new DomainError("not_found", "Library not found for this media file", {
				code: "media_file.library_not_found",
				params: { libraryId: mediaFile.libraryId },
			});
		}

		const mediaType = mapLibraryType(library.type);
		const targetMetadataId = await resolveReassignTarget(body, mediaType, mediaFile.libraryId);
		const { movieId: targetMovieId, episodeId: targetEpisodeId } = await resolveReassignAnchor(mediaType, body, targetMetadataId);

		// Ensure `isDefault` uniqueness atomically: a concurrent reassign to the
		// same movie/episode must not leave two defaults behind.
		await mediaRepository.reassign({
			mediaFileId,
			metadataId: targetMetadataId,
			movieId: targetMovieId,
			episodeId: targetEpisodeId,
		});

		recordAuditSafe(
			{
				action: "update",
				resourceType: "media_file_reassign",
				resourceId: mediaFileId,
				before: {
					metadataId: mediaFile.metadataId,
					movieId: mediaFile.movieId,
					episodeId: mediaFile.episodeId,
				},
				after: {
					metadataId: targetMetadataId,
					movieId: targetMovieId,
					episodeId: targetEpisodeId,
				},
				context,
			},
			state.logger,
		);

		const updated = await mediaRepository.findByIdForRead(mediaFileId, query);
		assertFound(updated, "MediaFile", mediaFileId);

		return updated;
	});
}
