import { Elysia } from "elysia";
import { RequestTimeoutError } from "@/utils/errors";

interface TimeoutContext {
	_timeoutTimer?: ReturnType<typeof setTimeout> | undefined;
	_timeoutFired?: boolean | undefined;
	request?: Request | undefined;
	requestId?: string | undefined;
}

function clearTimer(ref: TimeoutContext, key: "_timeoutTimer"): void {
	if (ref[key]) {
		clearTimeout(ref[key]);
		ref[key] = undefined;
	}
}

function throwTimeoutError(ctx: { request?: Request | undefined; requestId?: string | undefined }): never {
	const requestId = ctx.request?.headers.get("x-request-id") ?? ctx.requestId;
	throw new RequestTimeoutError("Request timed out", {
		code: "request.timeout",
		details: requestId ? { requestId } : undefined,
	});
}

/**
 * Per-route request timeout. The handler is not forcibly aborted (SQLite and
 * most handlers are synchronous); the route is checked on completion and a
 * `RequestTimeoutError` (408) is raised when the deadline elapsed.
 *
 * Usage per-route (macro applied to route options):
 *   .get("/slow", handler, { timeout: { ms: 60_000 } })
 */
function isTimer(val: unknown): val is ReturnType<typeof setTimeout> {
	return typeof val === "object" && val !== null && "hasRef" in val && typeof val.hasRef === "function";
}

export const requestTimeoutMiddleware = new Elysia({ name: "RequestTimeout" })
	.macro({
		timeout: (options: { ms: number }) => ({
			beforeHandle(ctx: TimeoutContext) {
				clearTimer(ctx, "_timeoutTimer");

				ctx._timeoutFired = false;
				ctx._timeoutTimer = setTimeout(() => {
					ctx._timeoutFired = true;
				}, options.ms);
				ctx._timeoutTimer.unref();
			},
			afterHandle(ctx: TimeoutContext) {
				clearTimer(ctx, "_timeoutTimer");

				if (ctx._timeoutFired) {
					throwTimeoutError(ctx);
				}
			},
		}),
	})
	.onError({ as: "global" }, ({ error, ...ctx }) => {
		if ("_timeoutTimer" in ctx && isTimer(ctx._timeoutTimer)) {
			clearTimeout(ctx._timeoutTimer);
		}

		// Only this middleware's own deadline may map to 408 — a client disconnect
		// or an unrelated AbortError must not be reported as a server timeout.
		const timeoutFired = "_timeoutFired" in ctx && ctx._timeoutFired === true;
		if (timeoutFired && (error instanceof DOMException || (error instanceof Error && error.name === "TimeoutError"))) {
			throwTimeoutError(ctx);
		}
	})
	.as("global");
