import type { CreateMediaMarker, MediaMarker, OperationQueuedResponse, PlaybackArtifact } from "@sdk/common";
import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type {
	MediaFileAuditStatus,
	MediaFileFilters,
	MediaFileSorting,
	MediaFileWithRelation,
	ReassignMediaFile,
	UpdateMediaFile,
} from "@sdk/common/media-file.types";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import { BaseResource, ReelVaultValidationError } from "../core/base-client";

export class MediaFileClient extends BaseResource {
	getAudit(): Promise<OperationQueuedResponse> {
		return this._get("/media-files/audit");
	}

	getAuditStatus(operationId: string): Promise<MediaFileAuditStatus> {
		return this._get(`/media-files/audit/${encodeURIComponent(operationId)}`);
	}

	getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & MediaFileFilters & MediaFileSorting,
	): Promise<PaginatedResponse<SelectFields<MediaFileWithRelation, F>>> {
		return this._get("/media-files", { query });
	}

	getById<F extends string>(mediaFileId: string, query?: FieldsQuery<F>): Promise<SelectFields<MediaFileWithRelation, F>> {
		return this._get(`/media-files/${mediaFileId}`, { query });
	}

	getArtifacts(mediaFileId: string): Promise<PlaybackArtifact[]> {
		return this._get(`/media-files/${mediaFileId}/artifacts`);
	}

	getArtifact(mediaFileId: string, artifactId: string): Promise<Blob | string> {
		return this._get(`/media-files/${mediaFileId}/artifacts/${artifactId}`);
	}

	getAllMarkers(): Promise<MediaMarker[]> {
		return this._get("/media-files/markers");
	}

	getMarkers(mediaFileId: string): Promise<MediaMarker[]> {
		return this._get(`/media-files/${mediaFileId}/markers`);
	}

	setMarkers(mediaFileId: string, markers: readonly CreateMediaMarker[]): Promise<MediaMarker[]> {
		try {
			assertValidMarkers(markers);
		} catch (error) {
			return Promise.reject(error);
		}

		return this._post(`/media-files/${mediaFileId}/markers`, { body: { markers } });
	}

	deleteMarkers(mediaFileId: string): Promise<{ success: boolean }> {
		return this._delete(`/media-files/${mediaFileId}/markers`);
	}

	refresh(mediaFileId: string): Promise<OperationQueuedResponse> {
		return this._post(`/media-files/${mediaFileId}/refresh`, { body: undefined });
	}

	scan(
		mediaFileId: string,
		options?: { durationSeconds?: number | null },
	): Promise<{
		exists: boolean;
		readable: boolean;
		sizeBytes: number | null;
		probeSuccess: boolean;
		probeError: string | null;
		decodeSuccess: boolean;
		decodeError: string | null;
		isEnabled: boolean;
	}> {
		return this._post(`/media-files/${mediaFileId}/scan`, { body: options });
	}

	refreshAll(): Promise<OperationQueuedResponse> {
		return this._post("/media-files/refresh", { body: undefined });
	}

	update<F extends string>(
		mediaFileId: string,
		body: UpdateMediaFile,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<MediaFileWithRelation, F>> {
		return this._patch(`/media-files/${mediaFileId}`, { body, query });
	}

	reassign<F extends string>(
		mediaFileId: string,
		body: ReassignMediaFile,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<MediaFileWithRelation, F>> {
		return this._post(`/media-files/${mediaFileId}/reassign`, { body, query });
	}

	delete(mediaFileId: string): Promise<{ success: boolean }> {
		return this._delete(`/media-files/${mediaFileId}`);
	}
}

function assertValidMarkers(markers: readonly CreateMediaMarker[]): void {
	const errors: Array<{ path: string; message: string; value: unknown }> = [];
	markers.forEach((marker, index) => {
		if (marker.type !== "highlight" && typeof marker.endSeconds === "number" && marker.endSeconds <= marker.startSeconds) {
			errors.push({
				path: `/markers/${index}/endSeconds`,
				message: "End time must be greater than start time (except for highlights).",
				value: marker.endSeconds,
			});
		}
	});
	if (errors.length > 0) {
		throw new ReelVaultValidationError(errors, { method: "POST", url: "/media-files/:mediaFileId/markers" });
	}
}
