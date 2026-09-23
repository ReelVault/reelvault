import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import type { PersonFilters, PersonSorting, PersonWithRelations } from "@sdk/common/people.types";
import { BaseResource } from "../core/base-client";

export class PeopleClient extends BaseResource {
	getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & PersonFilters & PersonSorting,
	): Promise<PaginatedResponse<SelectFields<PersonWithRelations, F>>> {
		return this._get("/people", { query });
	}

	getById<F extends string>(personId: string, query?: FieldsQuery<F>): Promise<SelectFields<PersonWithRelations, F>> {
		return this._get(`/people/${personId}`, { query });
	}

	refresh<F extends string>(personId: string): Promise<SelectFields<PersonWithRelations, F>> {
		return this._post(`/people/${personId}/refresh`);
	}

	refreshImage<F extends string>(personId: string): Promise<SelectFields<PersonWithRelations, F>> {
		return this._post(`/people/${personId}/refresh-image`);
	}
}
