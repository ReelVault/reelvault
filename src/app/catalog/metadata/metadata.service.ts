import type {
	CreateMetadata,
	CursorPaginatedResponse,
	CursorPaginationQuery,
	FieldsQuery,
	MetadataDetailsViewResponse,
	MetadataFilters,
	MetadataImageOption,
	MetadataSorting,
	MetadataWithRelation,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	SelectMetadataImage,
	UpdateMetadata,
} from "@reelvault/sdk/common";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import type { MetadataRootRow } from "@/app/repositories/metadata.repository";
import { createLogger } from "@/utils/logger.utils";
import { linkProvider, rematch } from "./providers/provider-link.service";
import { getImageOptions, refreshImages, refreshImagesMany, selectImage, uploadImage } from "./records/images.service";
import { getAll, getById, getDetailsView, getRootsById, getSimilar, getStatuses, searchGlobal } from "./records/reads.reader";
import { deleteMany, deleteOne, deleteOrphans } from "./records/remove.service";
import type { MetadataServiceState } from "./records/shared.utils";
import { create, mergeMetadata, update } from "./records/writes.writer";

class MetadataService {
	readonly serviceName = "MetadataService";
	readonly logger = createLogger("MetadataService");

	private readonly state: MetadataServiceState = { serviceName: this.serviceName, logger: this.logger };

	/**
	 * Retrieve poster and backdrop image options available from linked providers.
	 * Options are ranked by the provider's own score (best first); unscored
	 * candidates keep their provider order after the scored ones.
	 */
	async getImageOptions(metadataId: string): Promise<MetadataImageOption[]> {
		return await getImageOptions(this.state, metadataId);
	}

	/**
	 * Select and download a specific candidate image from a provider.
	 */
	async selectImage(metadataId: string, selection: SelectMetadataImage, context?: AdminAuditContext): Promise<{ success: true }> {
		return await selectImage(this.state, metadataId, selection, context);
	}

	/**
	 * Upload a custom poster or backdrop image for a metadata item.
	 */
	async uploadImage(metadataId: string, type: "poster" | "backdrop", file: File, context?: AdminAuditContext): Promise<{ success: true }> {
		return await uploadImage(this.state, metadataId, type, file, context);
	}

	async getStatuses(): Promise<{ statuses: string[] }> {
		return await getStatuses();
	}

	/**
	 * Search titles, people, collections and genres globally.
	 */
	async searchGlobal(query: string, limit = 6) {
		return await searchGlobal(this.state, query, limit);
	}

	async getAll<F extends string>(
		query?: CursorPaginationQuery & FieldsQuery<F> & MetadataFilters & MetadataSorting,
		viewerProfileId?: string,
	): Promise<CursorPaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
		return await getAll(this.state, query, viewerProfileId);
	}

	async getById<F extends string>(metadataId: string, query?: FieldsQuery<F>): Promise<SelectFields<MetadataWithRelation, F>> {
		return await getById(this.state, metadataId, query);
	}

	/**
	 * Flat metadata row without any relation queries. Use for composite views
	 * whose contract only carries the root row (playback view) — getById would
	 * run the full detail-page relation load for nothing.
	 */
	async getRootsById(metadataId: string): Promise<MetadataRootRow | undefined> {
		return await getRootsById(this.state, metadataId);
	}

	async getDetailsView(metadataId: string, profileId?: string): Promise<MetadataDetailsViewResponse> {
		return await getDetailsView(this.state, metadataId, profileId);
	}

	async create<F extends string>(
		body: CreateMetadata,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return await create(this.state, body, query, context);
	}

	async update<F extends string>(
		metadataId: string,
		body: UpdateMetadata,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return await update(this.state, metadataId, body, query, context);
	}

	async rematch<F extends string>(
		metadataId: string,
		body: { providerId: string; externalId: string; overwriteLocked?: boolean | undefined },
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return await rematch(this.state, metadataId, body, query, context);
	}

	/**
	 * Links an additional provider to an existing title and re-aggregates every
	 * linked provider by priority. Unlike {@link rematch}, the current primary
	 * provider is preserved — the new provider only fills gaps (and adds ratings).
	 */
	async linkProvider<F extends string>(
		metadataId: string,
		body: { providerId: string; externalId: string },
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return await linkProvider(this.state, metadataId, body, query, context);
	}

	/**
	 * Removes the listed titles one after another; each id reports its own outcome. A title whose files a stream is playing is
	 * held back unless `force` is set, because its files lose their title while playing.
	 */
	async deleteMany(metadataIds: string[], options: { force?: boolean | undefined } = {}, context?: AdminAuditContext) {
		return await deleteMany(this.state, metadataIds, options, context, (...args) => this.delete(...args));
	}

	async delete(metadataId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
		return await deleteOne(this.state, metadataId, context);
	}

	async deleteOrphans(context?: AdminAuditContext): Promise<{ count: number }> {
		return await deleteOrphans(this.state, context);
	}

	async mergeMetadata(targetId: string, sourceId: string, context?: AdminAuditContext): Promise<{ success: true; targetId: string }> {
		return await mergeMetadata(this.state, targetId, sourceId, context);
	}

	async getSimilar<F extends string>(
		metadataId: string,
		query?: PaginationQuery & FieldsQuery<F>,
		source?: SelectFields<MetadataWithRelation, string>,
	): Promise<PaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
		return await getSimilar(this.state, metadataId, query, source);
	}

	/** Force-refreshes the artwork of the listed titles one after another; each id reports its own outcome. */
	async refreshImagesMany(metadataIds: string[]) {
		return await refreshImagesMany(this.state, metadataIds, (...args) => this.refreshImages(...args));
	}

	async refreshImages(metadataId: string, options: { force?: boolean } = {}): Promise<{ success: boolean }> {
		return await refreshImages(this.state, metadataId, options);
	}
}

export const metadataService = new MetadataService();
