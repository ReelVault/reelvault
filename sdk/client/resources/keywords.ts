import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { Keyword, KeywordFilters, KeywordSorting } from "@sdk/common/keyword.types";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import { BaseResource } from "../core/base-client";

export class KeywordsClient extends BaseResource {
	getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & KeywordFilters & KeywordSorting,
	): Promise<PaginatedResponse<SelectFields<Keyword, F>>> {
		return this._get("/keywords", { query });
	}

	getById<F extends string>(keywordId: string, query?: FieldsQuery<F>): Promise<SelectFields<Keyword, F>> {
		return this._get(`/keywords/${keywordId}`, { query });
	}
}
