import type { Company, CompanyFilters, CompanySorting } from "@sdk/common/companies.types";
import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { Metadata } from "@sdk/common/metadata.types";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import { BaseResource } from "../core/base-client";

export class CompaniesClient extends BaseResource {
	getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & CompanyFilters & CompanySorting,
	): Promise<PaginatedResponse<SelectFields<Company, F>>> {
		return this._get("/companies", { query });
	}

	getById<F extends string>(companyId: string, query?: FieldsQuery<F>): Promise<SelectFields<Company, F>> {
		return this._get(`/companies/${companyId}`, { query });
	}

	getMetadata(companyId: string, query?: { limit?: number }): Promise<Metadata[]> {
		return this._get(`/companies/${companyId}/metadata`, { query });
	}
}
