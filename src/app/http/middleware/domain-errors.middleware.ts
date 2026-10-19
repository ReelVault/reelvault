import type { ApiErrorResponse } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { logRequestFailure } from "@/app/http/middleware/request-logger.middleware";
import { DomainError, type DomainErrorCategory, definedParams } from "@/utils/domain.errors";
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

	// A response that fails its own schema is a server bug, not bad client input —
	// reporting it as 400 sends clients off to "fix" a request that was fine.
	if (code === "VALIDATION" && error.type === "response") return { status: 500, code: "internal" };

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

/** The standard error envelope — every branch answers with the same shape. */
function errorResponse(
	status: number,
	code: string,
	requestId: string | undefined,
	extra?: { params?: Record<string, string | number | boolean | null> | undefined; details?: unknown },
): ApiErrorResponse {
	const response: ApiErrorResponse = { statusCode: status, code };
	if (extra?.params) response.params = extra.params;
	if (extra?.details !== undefined) response.details = extra.details;
	if (requestId) response.requestId = requestId;

	return response;
}

export const domainErrorsMiddleware = new Elysia({ name: "DomainErrors" }).onError({ as: "global" }, ({ error, set, ...ctx }) => {
	const requestId = "requestId" in ctx && typeof ctx.requestId === "string" ? ctx.requestId : undefined;
	const logContext = { ...ctx, set };

	if (error instanceof DomainError) {
		const status = statusByCategory[error.category];
		set.status = status;

		const params = definedParams(error.params);

		// Standard back-off hint: HTTP clients (and proxies) honour the header, not the JSON params.
		const retryAfter = params?.retryAfterSeconds;
		if (status === 429 && typeof retryAfter === "number" && retryAfter > 0) set.headers["retry-after"] = String(Math.ceil(retryAfter));

		logRequestFailure(logContext, { status, code: error.code, error });

		return errorResponse(status, error.code, requestId, { params, details: error.details });
	}

	const mapped = mapElysiaError(error);
	if (mapped) {
		set.status = mapped.status;

		logRequestFailure(logContext, { status: mapped.status, code: mapped.code, error });

		return errorResponse(mapped.status, mapped.code, requestId, { details: mapped.details });
	}

	// Last resort: a non-domain, non-Elysia error (typically a bug inside a
	// plugin route handler) still gets the standard envelope instead of Elysia's
	// plain-text 500.
	set.status = 500;

	logRequestFailure(logContext, { status: 500, code: "internal", error });

	return errorResponse(500, "internal", requestId);
});
