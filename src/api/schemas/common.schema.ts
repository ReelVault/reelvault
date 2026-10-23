import { ApiErrorResponseSchema, PaginatedResponseSchema, SuccessResponseSchema } from "@reelvault/sdk/common";
import type { TSchema } from "@sinclair/typebox";
import Elysia, { t } from "elysia";
import { serverConstants } from "@/config/server/server.constants";
import { clamp } from "@/utils/math.utils";

export { PaginatedResponseSchema };

/** An integer query value clamped to `[minimum, maximum]`. A fraction such as `1.5` is refused, not clamped: it would reach the response unchanged. */
export function ClampedNumeric(minimum: number, maximum: number, options?: Parameters<typeof t.Integer>[0]) {
	return t
		.Transform(t.Integer({ ...options }))
		.Decode((value) => clamp(value, minimum, maximum))
		.Encode((value) => value);
}

/** `page`/`limit` fields for routes that compose them with extra filters. */
export function paginationQueryFields(options?: {
	maxLimit?: number | undefined;
	defaultLimit?: number | undefined;
	defaultPage?: number | undefined;
}) {
	const maxLimit = options?.maxLimit ?? serverConstants.api.pagination.maxLimit;

	let page = ClampedNumeric(1, serverConstants.api.pagination.maxPage);
	if (options?.defaultPage !== undefined) {
		page = ClampedNumeric(1, serverConstants.api.pagination.maxPage, { default: options.defaultPage });
	}

	let limit = ClampedNumeric(1, maxLimit);
	if (options?.defaultLimit !== undefined) {
		limit = ClampedNumeric(1, maxLimit, { default: options.defaultLimit });
	}

	return { page: t.Optional(page), limit: t.Optional(limit) };
}

/** Offset pagination query — `page`/`limit` only; cursor endpoints use `CursorPaginationSchema`. */
export const PaginationSchema = t.Object(paginationQueryFields());

/** Standalone `page`/`limit` object with a route-specific cap. */
export function PaginationQuerySchema(options?: {
	maxLimit?: number | undefined;
	defaultLimit?: number | undefined;
	defaultPage?: number | undefined;
}) {
	return t.Object(paginationQueryFields(options));
}

/** Cursor-capable pagination query — only routes whose repository honors `cursor`. */
export const CursorPaginationSchema = t.Object({
	...paginationQueryFields(),
	cursor: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
});

export const FieldsSchema = t.Object({
	fields: t.Optional(t.String({ maxLength: 2048 })),
});

/**
 * The response schema for a handler that returns a `Response` rather than
 * JSON. Elysia sends such a body as-is and never schema-validates it, so the
 * schema only has to accept anything — `t.Any()` is deliberate.
 */
export const BinaryResponseSchema = { 200: t.Any() } as const;

/** A binary response that may also answer 304 when the client already holds it. */
export const BinaryNotModifiedSchema = { 200: t.Any(), 304: t.Any() } as const;

/**
 * The query schema of a list route: pagination, field selection, filters and
 * sorting.
 *
 * The slot order is fixed so TypeBox keeps the literal property types, and the
 * field-selection slot is always present — a list route that drops it would
 * silently ignore `?fields=`.
 */
export function listQuerySchema<TFilters extends TSchema, TSorting extends TSchema>(options: { filters: TFilters; sorting: TSorting }) {
	return t.Composite([PaginationSchema, FieldsSchema, options.filters, options.sorting]);
}

/** The query schema of a cursor-paginated list route. */
export function cursorListQuerySchema<TFilters extends TSchema, TSorting extends TSchema>(options: {
	filters: TFilters;
	sorting: TSorting;
}) {
	return t.Composite([CursorPaginationSchema, FieldsSchema, options.filters, options.sorting]);
}

export const commonModel = new Elysia().model({
	"error.response": ApiErrorResponseSchema,
	"success.response": SuccessResponseSchema,
	"fields.schema": FieldsSchema,
});

/**
 * Shared error-status composites for route `response` blocks. Keyed by HTTP
 * status with the shared `"error.response"` model — spreading one of these
 * replaces the per-route repetition of the same error pairs.
 */
const ERROR_RESPONSE = "error.response";

export const ROUTE_ERRORS = {
	/** Authenticated route without other documented failures. */
	AUTH: { 401: ERROR_RESPONSE },
	/** Admin route without other documented failures. */
	ADMIN: { 401: ERROR_RESPONSE, 403: ERROR_RESPONSE },
	/** Authenticated route with a 404 (entity may not exist). */
	NOT_FOUND: { 401: ERROR_RESPONSE, 404: ERROR_RESPONSE },
	/** Admin route with a 404. */
	ADMIN_NOT_FOUND: { 401: ERROR_RESPONSE, 403: ERROR_RESPONSE, 404: ERROR_RESPONSE },
	/** Body-validated route without a 404. */
	VALIDATED: { 400: ERROR_RESPONSE, 401: ERROR_RESPONSE },
	/** Body-validated route with a 404. */
	VALIDATED_NOT_FOUND: { 400: ERROR_RESPONSE, 401: ERROR_RESPONSE, 404: ERROR_RESPONSE },
	/** Body-validated admin route without a 404. */
	VALIDATED_ADMIN: { 400: ERROR_RESPONSE, 401: ERROR_RESPONSE, 403: ERROR_RESPONSE },
	/** Body-validated admin route with a 404. */
	VALIDATED_ADMIN_NOT_FOUND: {
		400: ERROR_RESPONSE,
		401: ERROR_RESPONSE,
		403: ERROR_RESPONSE,
		404: ERROR_RESPONSE,
	},
	/** Admin route with a 409 conflict (e.g. enable/disable state transitions). */
	ADMIN_CONFLICT: { 401: ERROR_RESPONSE, 403: ERROR_RESPONSE, 404: ERROR_RESPONSE, 409: ERROR_RESPONSE },
} as const;
