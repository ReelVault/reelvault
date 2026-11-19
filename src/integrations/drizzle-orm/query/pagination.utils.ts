import type { PaginatedResponse, PaginationConfig, PaginationQuery } from "@reelvault/sdk/common";
import { serverConstants } from "@/config/server/server.constants";
import { systemSettingsStore } from "@/config/system-settings.store";
import { clamp } from "@/utils/math.utils";

/** Parses URL parameters, applies limits and builds the pagination config (the default limit is a system setting). */
export function parsePagination(query: PaginationQuery): PaginationConfig {
	return resolvePageParams(query, { defaultLimit: systemSettingsStore.get("api.pagination.defaultLimit") });
}

/** Clamps page/limit to the configured bounds (admin defaults vary per endpoint) and computes the offset. */
export function resolvePageParams(
	query: { page?: number | undefined; limit?: number | undefined },
	options: { defaultLimit: number; maxLimit?: number | undefined },
): PaginationConfig {
	const maxLimit = options.maxLimit ?? serverConstants.api.pagination.maxLimit;
	const page = clamp(query.page ?? 1, 1, serverConstants.api.pagination.maxPage);
	const limit = clamp(query.limit ?? options.defaultLimit, 1, maxLimit);

	return { page, limit, offset: (page - 1) * limit };
}

/** Admin pagination meta — zero pages for an empty result, like `createPageResponse`. */
export function buildAdminPagination({ total, page, limit }: { total: number; page: number; limit: number }) {
	return { page, limit, total, totalPages: total > 0 ? Math.ceil(total / limit) : 0 };
}

/** Builds a paginated response. */
export function createPageResponse<T>({
	total,
	pagination,
	data,
}: {
	total: number;
	pagination: PaginationConfig;
	data: T[];
}): PaginatedResponse<T> {
	return {
		page: pagination.page,
		limit: pagination.limit,
		total: total,
		totalPages: total > 0 ? Math.ceil(total / pagination.limit) : 0,
		data,
	};
}
