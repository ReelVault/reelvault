export interface PaginationQuery {
	page?: number | undefined;
	limit?: number | undefined;
	cursor?: string | undefined;
}

export interface PaginationConfig {
	page: number;
	limit: number;
	offset: number;
}

export interface PaginatedResponse<T> {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
	nextCursor?: string;
	data: T[];
}
