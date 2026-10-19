import type {
	CreateMediaMarker,
	FieldsQuery,
	MediaFileAuditResponse,
	MediaFileAuditStatus,
	MediaFileFilters,
	MediaFileSorting,
	MediaFileWithRelation,
	MediaMarker,
	MediaMarkerFilters,
	PaginatedResponse,
	PaginationQuery,
	PlaybackArtifact,
	ReassignMediaFile,
	SelectFields,
	UpdateMediaFile,
} from "@reelvault/sdk/common";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import type { MediaMarkerListQuery } from "@/app/repositories/media-markers.repository";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { getAuditStatus, queueAudit } from "./audit.service";
import { reassign } from "./maintenance/reassign.service";
import { refresh, refreshAll, refreshMany, update } from "./maintenance/refresh.service";
import { deleteMany, deleteOne } from "./maintenance/remove.service";
import { deleteMarkers, exportMarkers, importMarkers, setMarkers } from "./markers.service";
import { getAll, getArtifact, getById, listAllMarkers, listArtifacts, listMarkers } from "./queries.reader";
import type { MediaFileScanResult } from "./scan.service";
import { scan } from "./scan.service";
import type { MediaServiceState } from "./shared.utils";

class MediaService {
	readonly serviceName = "MediaService";

	readonly logger = createLogger("MediaService");

	private readonly state: MediaServiceState = {
		serviceName: this.serviceName,
		logger: this.logger,
		auditResultCache: new MemoryCache<MediaFileAuditResponse>({ ttlMs: -1, maxSize: 8, name: "media-file-audit-results" }),
	};

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & MediaFileFilters & MediaFileSorting,
	): Promise<PaginatedResponse<SelectFields<MediaFileWithRelation, F>>> {
		return await getAll(this.state, query);
	}

	async getById<F extends string>(mediaFileId: string, query?: FieldsQuery<F>): Promise<SelectFields<MediaFileWithRelation, F>> {
		return await getById(this.state, mediaFileId, query);
	}

	async listArtifacts(mediaFileId: string, options?: { skipExistsCheck?: boolean }): Promise<PlaybackArtifact[]> {
		return await listArtifacts(this.state, mediaFileId, options);
	}

	async getArtifact(mediaFileId: string, artifactId: string): Promise<{ artifact: PlaybackArtifact; file: Blob }> {
		return await getArtifact(this.state, mediaFileId, artifactId);
	}

	async listMarkers(mediaFileId: string, options?: { skipExistsCheck?: boolean }): Promise<MediaMarker[]> {
		return await listMarkers(this.state, mediaFileId, options);
	}

	async listAllMarkers(query: MediaMarkerListQuery & { page?: number } = {}) {
		return await listAllMarkers(this.state, query);
	}

	/** Every marker matching the filters as NDJSON; an export past the cap is refused rather than cut short. */
	async exportMarkers(query: MediaMarkerFilters): Promise<string> {
		return await exportMarkers(this.state, query);
	}

	/**
	 * Replaces the markers of every media file the NDJSON names, one file at a time. Every file is checked
	 * before the first marker is written, so an unknown file refuses the whole import.
	 */
	async importMarkers(text: string, context?: AdminAuditContext): Promise<{ mediaFiles: number; markers: number }> {
		return await importMarkers(this.state, text, context, (...args) => this.setMarkers(...args));
	}

	async setMarkers(
		mediaFileId: string,
		markers: readonly CreateMediaMarker[],
		options?: { pluginId?: string; source?: "automatic" | "manual" | "plugin" },
		context?: AdminAuditContext,
	): Promise<MediaMarker[]> {
		return await setMarkers(this.state, mediaFileId, markers, options, context);
	}

	async deleteMarkers(mediaFileId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
		return await deleteMarkers(this.state, mediaFileId, context);
	}

	async update<F extends string>(
		mediaFileId: string,
		body: UpdateMediaFile,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MediaFileWithRelation, F>> {
		return await update(this.state, mediaFileId, body, query, context);
	}

	async refresh(mediaFileId: string, context?: AdminAuditContext) {
		return await refresh(this.state, mediaFileId, context);
	}

	/** Queues a technical refresh for each listed media file; a file that cannot be queued reports its own code. */
	async refreshMany(mediaFileIds: string[], context?: AdminAuditContext) {
		return await refreshMany(this.state, mediaFileIds, context, (...args) => this.refresh(...args));
	}

	async refreshAll(context?: AdminAuditContext) {
		return await refreshAll(this.state, context);
	}

	async scan(mediaFileId: string, options?: { durationSeconds?: number | null } | null): Promise<MediaFileScanResult> {
		return await scan(this.state, mediaFileId, options);
	}

	async reassign<F extends string>(
		mediaFileId: string,
		body: ReassignMediaFile,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MediaFileWithRelation, F>> {
		return await reassign(this.state, mediaFileId, body, query, context);
	}

	/** Queues the full-catalog audit as a background operation (route returns 202). */
	async queueAudit(context?: AdminAuditContext): Promise<{ success: true; operationId: string; status: "pending" }> {
		return await queueAudit(this.state, context);
	}

	/** Polls an audit operation; `result` is populated once it completes. */
	async getAuditStatus(operationId: string): Promise<MediaFileAuditStatus> {
		return await getAuditStatus(this.state, operationId);
	}

	/**
	 * Removes the listed media file records one after another; each id reports its own outcome. Files a stream is playing are
	 * held back unless `force` is set, because deleting the record ends that playback.
	 */
	async deleteMany(mediaFileIds: string[], options: { force?: boolean | undefined } = {}, context?: AdminAuditContext) {
		return await deleteMany(this.state, mediaFileIds, options, context, (...args) => this.delete(...args));
	}

	async delete(
		mediaFileId: string,
		context?: AdminAuditContext,
		options: { force?: boolean | undefined } = {},
	): Promise<{ success: boolean }> {
		return await deleteOne(this.state, mediaFileId, context, (...args) => this.getById(...args), options);
	}
}

export const mediaService = new MediaService();
