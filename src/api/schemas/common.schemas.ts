import { ApiErrorResponseSchema, PaginatedResponseSchema, SuccessResponseSchema } from "@reelvault/sdk/common";
import Elysia, { t } from "elysia";
import { clamp } from "@/utils/math.utils";

export { PaginatedResponseSchema };

export function ClampedNumeric(minimum: number, maximum: number, options?: Parameters<typeof t.Numeric>[0]) {
	return t
		.Transform(t.Numeric({ ...options }))
		.Decode((value) => clamp(value, minimum, maximum))
		.Encode((value) => value);
}

export const PaginationSchema = t.Object({
	page: t.Optional(ClampedNumeric(1, 1000)),
	limit: t.Optional(ClampedNumeric(1, 100)),
	cursor: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
});

export const FieldsSchema = t.Object({
	fields: t.Optional(t.String({ maxLength: 2048 })),
});

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
export const ROUTE_ERRORS = {
	/** Authenticated route without other documented failures. */
	AUTH: { 401: "error.response" },
	/** Admin route without other documented failures. */
	ADMIN: { 401: "error.response", 403: "error.response" },
	/** Authenticated route with a 404 (entity may not exist). */
	NOT_FOUND: { 401: "error.response", 404: "error.response" },
	/** Admin route with a 404. */
	ADMIN_NOT_FOUND: { 401: "error.response", 403: "error.response", 404: "error.response" },
	/** Body-validated route without a 404. */
	VALIDATED: { 400: "error.response", 401: "error.response" },
	/** Body-validated route with a 404. */
	VALIDATED_NOT_FOUND: { 400: "error.response", 401: "error.response", 404: "error.response" },
	/** Body-validated admin route without a 404. */
	VALIDATED_ADMIN: { 400: "error.response", 401: "error.response", 403: "error.response" },
	/** Body-validated admin route with a 404. */
	VALIDATED_ADMIN_NOT_FOUND: {
		400: "error.response",
		401: "error.response",
		403: "error.response",
		404: "error.response",
	},
	/** Admin route with a 409 conflict (e.g. enable/disable state transitions). */
	ADMIN_CONFLICT: { 401: "error.response", 403: "error.response", 404: "error.response", 409: "error.response" },
	/** Body-validated admin route with a 409 conflict but no 404. */
	VALIDATED_ADMIN_CONFLICT: { 400: "error.response", 401: "error.response", 403: "error.response", 409: "error.response" },
	/** Body-validated admin route that is rate-limited (429) without a 409. */
	VALIDATED_ADMIN_RATE_LIMITED: { 400: "error.response", 401: "error.response", 403: "error.response", 429: "error.response" },
	/** Body-validated admin route that is both rate-limited (429) and conflict-prone (409). */
	VALIDATED_ADMIN_CONFLICT_RATE_LIMITED: {
		400: "error.response",
		401: "error.response",
		403: "error.response",
		409: "error.response",
		429: "error.response",
	},
} as const;
