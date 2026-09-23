import type { ApiErrorResponse } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { hasEntry } from "@/utils/array.utils";
import { DomainError, type DomainErrorCategory, type DomainErrorParams } from "@/utils/errors";
import { isRecord } from "@/utils/type.utils";

const statusByCategory: Record<DomainErrorCategory, number> = {
	validation: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	timeout: 408,
	too_many_requests: 429,
	internal: 500,
};

interface ElysiaMappedError {
	status: number;
	code: string;
	details?: unknown;
}

/**
 * Maps Elysia's built-in errors (request validation, JSON parse, route miss,
 * cookie signature) onto the same `code` + `params` envelope as DomainError.
 */
const ELYSIA_ERROR_MAP: Record<string, { status: number; code: string; hasDetails?: boolean }> = {
	VALIDATION: { status: 400, code: "validation.invalid_request", hasDetails: true },
	PARSE: { status: 400, code: "validation.invalid_request" },
	NOT_FOUND: { status: 404, code: "not_found" },
	INVALID_COOKIE_SIGNATURE: { status: 401, code: "unauthorized" },
};

function mapElysiaError(error: unknown): ElysiaMappedError | undefined {
	if (!isRecord(error)) return undefined;

	const code = error.code;
	if (typeof code !== "string") return undefined;

	const mapped = ELYSIA_ERROR_MAP[code];
	if (!mapped) return undefined;

	return {
		status: mapped.status,
		code: mapped.code,
		...(mapped.hasDetails ? { details: projectValidationDetails(error.all) } : {}),
	};
}

/**
 * Elysia's `error.all` entries include the offending `value`, which for auth
 * payloads can be a submitted password. Keep only path + message.
 */
function projectValidationDetails(all: unknown): Array<{ path: string; message: string }> | undefined {
	if (!Array.isArray(all)) return undefined;

	const details = all
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map((entry) => ({
			path: typeof entry.path === "string" ? entry.path : "",
			message: typeof entry.message === "string" ? entry.message : "Invalid value",
		}));

	return details.length > 0 ? details : undefined;
}

export const domainErrorsMiddleware = new Elysia({ name: "DomainErrors" }).onError({ as: "global" }, ({ error, set, ...ctx }) => {
	const requestId = "requestId" in ctx && typeof ctx.requestId === "string" ? ctx.requestId : undefined;

	if (error instanceof DomainError) {
		const status = statusByCategory[error.category];
		set.status = status;

		const response: ApiErrorResponse = { statusCode: status, code: error.code };
		const params = definedParams(error.params);
		if (params) response.params = params;

		if (requestId) response.requestId = requestId;

		if (error.details) response.details = error.details;

		return response;
	}

	const mapped = mapElysiaError(error);
	if (mapped) {
		set.status = mapped.status;
		const response: ApiErrorResponse = { statusCode: mapped.status, code: mapped.code };
		if (mapped.details !== undefined) response.details = mapped.details;

		if (requestId) response.requestId = requestId;

		return response;
	}

	// Last resort: a non-domain, non-Elysia error (typically a bug inside a
	// plugin route handler) still gets the standard envelope instead of Elysia's
	// plain-text 500. The error-level log for this case is owned by
	// request-logger's global onError.
	set.status = 500;
	const fallback: ApiErrorResponse = { statusCode: 500, code: "internal" };
	if (requestId) fallback.requestId = requestId;

	return fallback;
});

function definedParams(params: DomainErrorParams | undefined): Record<string, string | number | boolean | null> | undefined {
	if (!params) return undefined;

	const defined: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) defined[key] = value;
	}

	return hasEntry(defined) ? defined : undefined;
}
