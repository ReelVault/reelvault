import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import type { Season, SeasonFilters, SeasonSorting } from "@sdk/common/season.types";
import { BaseResource } from "../core/base-client";

export class SeasonsClient extends BaseResource {
	getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & SeasonFilters & SeasonSorting,
	): Promise<PaginatedResponse<SelectFields<Season, F>>> {
		return this._get("/seasons", { query });
	}

	getById<F extends string>(seasonId: string, query?: FieldsQuery<F>): Promise<SelectFields<Season, F>> {
		return this._get(`/seasons/${seasonId}`, { query });
	}
}
