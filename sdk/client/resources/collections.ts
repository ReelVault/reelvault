import type { CollectionFilters, CollectionWithRelations, UpdateCollection } from "@sdk/common/collection.types";

import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import type { SortQuery } from "@sdk/common/sorting";
import { BaseResource } from "../core/base-client";

export class CollectionsClient extends BaseResource {
	getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & CollectionFilters & SortQuery,
	): Promise<PaginatedResponse<SelectFields<CollectionWithRelations, F>>> {
		return this._get("/collections", { query });
	}

	getById<F extends string>(collectionId: string, query?: FieldsQuery<F>): Promise<SelectFields<CollectionWithRelations, F>> {
		return this._get(`/collections/${collectionId}`, { query });
	}

	update<F extends string>(
		collectionId: string,
		body: UpdateCollection,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<CollectionWithRelations, F>> {
		return this._patch(`/admin/collections/${collectionId}`, { body, query });
	}

	updateOrder(collectionId: string, metadataIds: string[]): Promise<{ success: boolean }> {
		return this._put(`/admin/collections/${collectionId}/order`, { body: { metadataIds } });
	}
}
