import type {
	EpisodeWithRelations,
	FieldsQuery,
	MediaFileFilters,
	MediaFileSorting,
	MediaFileWithRelation,
	MediaMarker,
	PaginatedResponse,
	PaginationQuery,
	PlaybackArtifact,
	SelectFields,
} from "@reelvault/sdk/common";
import { createPageResponse, resolvePageParams } from "@/integrations/drizzle-orm/query/pagination.utils";
import { toPublicMarker } from "@/integrations/drizzle-orm/utils/media-marker.mapper";
import { mediaRepository, type PlaybackContext } from "@/repositories/media-files.repository";
import { type MediaMarkerListQuery, mediaMarkersRepository } from "@/repositories/media-markers.repository";
import { mediaArtifactsService } from "@/services/artifacts/media-artifacts.service";
import { assertExists, assertFound } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { mediaFilesLog } from "./media-files.logger";

export async function assertMediaFileExists(mediaFileId: string): Promise<void> {
	const mediaFileExists = await mediaRepository.isExists({ primaryId: mediaFileId });
	assertExists(mediaFileExists, "MediaFile", mediaFileId);
}

export async function getAll<F extends string>(
	query?: PaginationQuery & FieldsQuery<F> & MediaFileFilters & MediaFileSorting,
): Promise<PaginatedResponse<SelectFields<MediaFileWithRelation, F>>> {
	return await runSafely(mediaFilesLog, "getAll", async () => await mediaRepository.findPage(query));
}

export async function getById<F extends string>(
	mediaFileId: string,
	query?: FieldsQuery<F>,
): Promise<SelectFields<MediaFileWithRelation, F>> {
	return await runSafely(mediaFilesLog, "getById", async () => {
		const media = await mediaRepository.findByIdForRead(mediaFileId, query);

		assertFound(media, "MediaFile", mediaFileId);

		return media;
	});
}

/** Playback view payload: the file, its markers, its root metadata row and its episode, read in one statement. */
export interface PlaybackContextData {
	mediaFile: MediaFileWithRelation;
	metadata: PlaybackContext["metadata"];
	episode: EpisodeWithRelations | undefined;
	markers: MediaMarker[];
}

/** The playback view's bootstrap read — one statement instead of file + markers + root metadata + episode. */
export async function getPlaybackContext(mediaFileId: string): Promise<PlaybackContextData> {
	return await runSafely(mediaFilesLog, "getPlaybackContext", async () => {
		const context = await mediaRepository.findPlaybackContext(mediaFileId);
		assertFound(context, "MediaFile", mediaFileId);

		return {
			mediaFile: context.mediaFile,
			metadata: context.metadata,
			episode: context.episode,
			markers: context.markers.map((item) => toPublicMarker(item)),
		};
	});
}

export async function listArtifacts(mediaFileId: string, options?: { skipExistsCheck?: boolean }): Promise<PlaybackArtifact[]> {
	return await runSafely(mediaFilesLog, "listArtifacts", async () => {
		if (!options?.skipExistsCheck) await assertMediaFileExists(mediaFileId);

		return await mediaArtifactsService.list(mediaFileId);
	});
}

export async function getArtifact(mediaFileId: string, artifactId: string): Promise<{ artifact: PlaybackArtifact; file: Blob }> {
	return await runSafely(mediaFilesLog, "getArtifact", async () => {
		const artifact = await mediaArtifactsService.findFile(mediaFileId, artifactId);
		assertFound(artifact, "PlaybackArtifact", artifactId);

		return artifact;
	});
}

export async function listMarkers(mediaFileId: string, options?: { skipExistsCheck?: boolean }): Promise<MediaMarker[]> {
	return await runSafely(mediaFilesLog, "listMarkers", async () => {
		if (!options?.skipExistsCheck) await assertMediaFileExists(mediaFileId);

		const markers = await mediaMarkersRepository.findByMediaFileId(mediaFileId);

		return markers.map((item) => toPublicMarker(item));
	});
}

export async function listAllMarkers(query: MediaMarkerListQuery & { page?: number } = {}) {
	return await runSafely(mediaFilesLog, "listAllMarkers", async () => {
		// Filters and LIMIT run in SQL — fetching every marker row to filter or slice in JS
		// would read the whole table on a user-triggerable route.
		const pagination = resolvePageParams(query, { defaultLimit: 100 });
		const { rows, total } = await mediaMarkersRepository.findPage({ ...query, limit: pagination.limit, offset: pagination.offset });

		return createPageResponse({ total, pagination, data: rows.map((item) => toPublicMarker(item)) });
	});
}
