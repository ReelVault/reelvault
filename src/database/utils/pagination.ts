import type { PaginatedResponse, PaginationConfig, PaginationQuery } from "@reelvault/sdk/common";
import { serverConfig } from "@/server.config";
import { clamp } from "@/utils/math.utils";

export const QueryPagination = {
	/**
	 * Parses URL parameters, applies limits and builds the pagination config
	 */
	parse(query: PaginationQuery): PaginationConfig {
		const page = clamp(query.page ?? 1, 1, serverConfig.api.pagination.maxPage);
		const limit = clamp(query.limit ?? serverConfig.api.pagination.defaultLimit, 1, serverConfig.api.pagination.maxLimit);
		const offset = (page - 1) * limit;

		return { page, limit, offset };
	},

	/**
	 * Clamps admin page/limit (admin defaults vary per endpoint) and computes the offset.
	 */
	resolvePageParams(
		query: { page?: number | undefined; limit?: number | undefined },
		options: { defaultLimit: number; maxLimit?: number | undefined },
	): PaginationConfig {
		const maxLimit = options.maxLimit ?? serverConfig.api.pagination.maxLimit;
		const page = Math.max(1, query.page ?? 1);
		const limit = clamp(query.limit ?? options.defaultLimit, 1, maxLimit);

		return { page, limit, offset: (page - 1) * limit };
	},

	/** Admin pagination block — always at least one page, even for an empty result. */
	buildAdminPagination({ total, page, limit }: { total: number; page: number; limit: number }) {
		return { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
	},

	/**
	 * Builds a paginated response
	 */
	createResponse<T>({ total, pagination, data }: { total: number; pagination: PaginationConfig; data: T[] }): PaginatedResponse<T> {
		return {
			page: pagination.page,
			limit: pagination.limit,
			total: total,
			totalPages: total > 0 ? Math.ceil(total / pagination.limit) : 0,
			data,
		};
	},
};
