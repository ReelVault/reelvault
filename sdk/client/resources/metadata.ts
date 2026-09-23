import type { MetadataDetailsViewResponse } from "@sdk/common";
import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { GlobalSearchResponse } from "@sdk/common/metadata";

import type { MetadataFilters, MetadataSorting, MetadataWithRelation, UpdateMetadata } from "@sdk/common/metadata.types";
import type { MetadataImageOption, SelectMetadataImage } from "@sdk/common/metadata-images";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import { BaseResource } from "../core/base-client";

export class MetadataClient extends BaseResource {
	getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & MetadataFilters & MetadataSorting,
	): Promise<PaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
		return this._get("/metadata", { query });
	}

	getById<F extends string>(metadataId: string, query?: FieldsQuery<F>): Promise<SelectFields<MetadataWithRelation, F>> {
		return this._get(`/metadata/${metadataId}`, { query });
	}

	getDetailsView(metadataId: string): Promise<MetadataDetailsViewResponse> {
		return this._get(`/metadata/${metadataId}/details-view`);
	}

	update<F extends string>(
		metadataId: string,
		body: UpdateMetadata,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return this._patch(`/metadata/${metadataId}`, { body, query });
	}

	rematch<F extends string>(
		metadataId: string,
		body: { providerId: string; externalId: string },
		query?: FieldsQuery<F>,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return this._post(`/metadata/${metadataId}/rematch`, { body, query });
	}

	/** Links an additional provider and re-aggregates without replacing the primary provider. */
	linkProvider<F extends string>(
		metadataId: string,
		body: { providerId: string; externalId: string },
		query?: FieldsQuery<F>,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return this._post(`/metadata/${metadataId}/providers`, { body, query });
	}

	getImageOptions(metadataId: string): Promise<MetadataImageOption[]> {
		return this._get(`/metadata/${metadataId}/images/options`);
	}

	selectImage(metadataId: string, body: SelectMetadataImage): Promise<{ success: boolean }> {
		return this._post(`/metadata/${metadataId}/images/select`, { body });
	}

	uploadImage(metadataId: string, type: "poster" | "backdrop", file: Blob): Promise<{ success: boolean }> {
		const body = new FormData();
		body.set("type", type);
		body.set("file", file, `${type}.upload`);

		return this._post(`/metadata/${metadataId}/images/upload`, { body });
	}

	refreshImages(metadataId: string, body?: { force?: boolean }): Promise<{ success: boolean }> {
		return this._post(`/metadata/${metadataId}/refresh-images`, { body });
	}

	merge(metadataId: string, sourceMetadataId: string): Promise<{ success: true; targetId: string }> {
		return this._post(`/metadata/${metadataId}/merge`, { body: { sourceMetadataId } });
	}

	delete(metadataId: string): Promise<{ success: boolean }> {
		return this._delete(`/metadata/${metadataId}`);
	}

	getSimilar<F extends string>(
		metadataId: string,
		query?: PaginationQuery & FieldsQuery<F>,
	): Promise<PaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
		return this._get(`/metadata/${metadataId}/similar`, { query });
	}

	searchGlobal(query: string, limit = 6): Promise<GlobalSearchResponse> {
		return this._get("/metadata/search/global", { query: { q: query, limit } });
	}
}
