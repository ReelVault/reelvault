import { Elysia } from "elysia";
import { getPathname, getResponseStatus } from "@/utils/http.utils";
import { createLogger } from "@/utils/logger";

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
 * Structured access log middleware.
 * Logs method, path, status code, duration and userId for every request.
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
		const status = responseValue instanceof Response ? responseValue.status : getResponseStatus(set);
		const meta = extractLogMeta(context, { status });
		logger.info(`${String(meta.method)} ${String(meta.path)} → ${String(status)}`, meta);
	})
	.onError({ as: "global" }, (context) => {
		const { error, code, set } = context;
		const status = getResponseStatus(set, 500);
		const meta = extractLogMeta(context, { code, status });
		const { method, path } = meta;
		if (status >= 400 && status < 500) {
			logger.warn(`${String(method)} ${String(path)} → ${String(status)} (${String(code)})`, meta);
		} else {
			logger.error(`${String(method)} ${String(path)} → ${String(status)} (${String(code)})`, error, meta);
		}
	});
