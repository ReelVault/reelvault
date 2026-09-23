import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { Genre, GenreFilters, GenreSorting } from "@sdk/common/genre.types";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import { BaseResource } from "../core/base-client";

export class GenresClient extends BaseResource {
	getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & GenreFilters & GenreSorting,
	): Promise<PaginatedResponse<SelectFields<Genre, F>>> {
		return this._get("/genres", { query });
	}

	getById<F extends string>(genreId: string, query?: FieldsQuery<F>): Promise<SelectFields<Genre, F>> {
		return this._get(`/genres/${genreId}`, { query });
	}
}
