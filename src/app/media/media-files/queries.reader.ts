import type {
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
import { mediaArtifactsService } from "@/app/artifacts/media-artifacts.service";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { type MediaMarkerListQuery, mediaMarkersRepository } from "@/app/repositories/media-markers.repository";
import { QueryPagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { toPublicMarker } from "@/integrations/drizzle-orm/utils/media-marker.mapper";
import { assertFound } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import type { MediaServiceState } from "./shared.utils";
import { assertMediaFileExists } from "./shared.utils";

export async function getAll<F extends string>(
	state: MediaServiceState,
	query?: PaginationQuery & FieldsQuery<F> & MediaFileFilters & MediaFileSorting,
): Promise<PaginatedResponse<SelectFields<MediaFileWithRelation, F>>> {
	return await runSafely(state, "getAll", async () => await mediaRepository.findPage(query));
}

export async function getById<F extends string>(
	state: MediaServiceState,
	mediaFileId: string,
	query?: FieldsQuery<F>,
): Promise<SelectFields<MediaFileWithRelation, F>> {
	return await runSafely(state, "getById", async () => {
		const media = await mediaRepository.findByIdForRead(mediaFileId, query);

		assertFound(media, "MediaFile", mediaFileId);

		return media;
	});
}

export async function listArtifacts(
	state: MediaServiceState,
	mediaFileId: string,
	options?: { skipExistsCheck?: boolean },
): Promise<PlaybackArtifact[]> {
	return await runSafely(state, "listArtifacts", async () => {
		if (!options?.skipExistsCheck) await assertMediaFileExists(mediaFileId);

		return await mediaArtifactsService.list(mediaFileId);
	});
}

export async function getArtifact(
	state: MediaServiceState,
	mediaFileId: string,
	artifactId: string,
): Promise<{ artifact: PlaybackArtifact; file: Blob }> {
	return await runSafely(state, "getArtifact", async () => {
		const artifact = await mediaArtifactsService.findFile(mediaFileId, artifactId);
		assertFound(artifact, "PlaybackArtifact", artifactId);

		return artifact;
	});
}

export async function listMarkers(
	state: MediaServiceState,
	mediaFileId: string,
	options?: { skipExistsCheck?: boolean },
): Promise<MediaMarker[]> {
	return await runSafely(state, "listMarkers", async () => {
		if (!options?.skipExistsCheck) await assertMediaFileExists(mediaFileId);

		const markers = await mediaMarkersRepository.findByMediaFileId(mediaFileId);

		return markers.map((item) => toPublicMarker(item));
	});
}

export async function listAllMarkers(state: MediaServiceState, query: MediaMarkerListQuery & { page?: number } = {}) {
	return await runSafely(state, "listAllMarkers", async () => {
		// Filters and LIMIT run in SQL — fetching every marker row to filter or slice in JS
		// would read the whole table on a user-triggerable route.
		const pagination = QueryPagination.resolvePageParams(query, { defaultLimit: 100 });
		const { rows, total } = await mediaMarkersRepository.findPage({ ...query, limit: pagination.limit, offset: pagination.offset });

		return QueryPagination.createResponse({ total, pagination, data: rows.map((item) => toPublicMarker(item)) });
	});
}
