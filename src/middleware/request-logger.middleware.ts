import { Elysia, ElysiaCustomStatusResponse } from "elysia";
import { getPathname, getResponseStatus } from "@/utils/http.utils";
import { createLogger, logAccessRecord } from "@/utils/logger";

const logger = createLogger("RequestLogger");

interface AuthContext {
	user?: { id: string } | null | undefined;
	profile?: { id: string } | null | undefined;
}

interface LogContext {
	request: Request;
	set: { status?: number | string };
	requestId?: string;
	requestStartedAt?: number;
}

/**
 * The status a response is sent with. A `Response` carries its own; a `status(code, body)` result is applied to the
 * context only after the hook runs, so its code is read from the result itself. Anything else takes the context status.
 */
export function responseStatus(responseValue: unknown, set: { status?: number | string }): number {
	if (responseValue instanceof Response) return responseValue.status;
	if (responseValue instanceof ElysiaCustomStatusResponse) {
		const code: unknown = responseValue.code;
		if (typeof code === "number") return code;
	}

	return getResponseStatus(set);
}

function extractLogMeta(context: LogContext & Partial<AuthContext>, extra?: Record<string, unknown>): Record<string, unknown> {
	const { request, requestId, requestStartedAt, user, profile } = context;
	const method = request.method;
	const path = getPathname(request.url);
	const durationMs = Math.round(performance.now() - (requestStartedAt ?? performance.now()));
	const meta: Record<string, unknown> = { requestId, path, method, durationMs, ...extra };
	if (user?.id) meta.userId = user.id;

	if (profile?.id) meta.profileId = profile.id;

	return meta;
}

/**
 * Logs a failed request. Called by the error middleware because Elysia stops at
 * the first `onError` handler that returns a response — the error middleware
 * always returns one, so a request logger's own `onError` would never run.
 */
export function logRequestFailure(
	context: LogContext & Partial<AuthContext>,
	outcome: { status: number; code?: string | undefined; error?: unknown },
): void {
	const meta = extractLogMeta(context, { status: outcome.status, code: outcome.code });
	const { method, path } = meta;
	const suffix = outcome.code === undefined ? "" : ` (${outcome.code})`;

	if (outcome.status >= 400 && outcome.status < 500) {
		logger.warn(`${String(method)} ${String(path)} → ${String(outcome.status)}${suffix}`, meta);
	} else {
		logger.error(`${String(method)} ${String(path)} → ${String(outcome.status)}${suffix}`, outcome.error, meta);
	}
}

/**
 * Structured access log middleware.
 * Logs method, path, status code, duration and userId for every successful
 * request. Failures are logged by `domainErrorsMiddleware` via
 * `logRequestFailure` (see that middleware for why).
 */
export const requestLoggerMiddleware = new Elysia({ name: "RequestLogger" })
	.derive({ as: "global" }, ({ request, set }) => {
		const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
		set.headers["x-request-id"] = requestId;

		return {
			requestId,
			requestStartedAt: performance.now(),
		};
	})
	.onAfterHandle({ as: "global" }, (context) => {
		const { responseValue, set } = context;
		const status = responseStatus(responseValue, set);
		const meta = extractLogMeta(context, { status });
		const message = `${String(meta.method)} ${String(meta.path)} → ${String(status)}`;
		// Production JSON console logs through the access fast path; development
		// (pino-pretty) and tests fall back to the regular logger.
		if (!logAccessRecord(message, meta)) logger.info(message, meta);
	});
