import {
	ActiveSessionsResponseSchema,
	LoginRequestSchema,
	LoginResponseSchema,
	LogoutResponseSchema,
	RegisterRequestSchema,
	RegisterResponseSchema,
	SessionResponseSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { authService } from "@/application/auth/auth.service";
import { sessionsService } from "@/application/auth/sessions.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";
import { ForbiddenError } from "@/utils/errors";
import { isOriginAllowed } from "@/utils/http.utils";
import { quickConnectRoutes } from "./quick-connect.routes";

export const authRoutes = new Elysia({
	prefix: "/auth",
	tags: ["Auth"],
})
	.use(commonModel)
	.use(rateLimitMiddleware)
	.use(quickConnectRoutes)
	.onBeforeHandle(({ request }) => {
		// Origin check for state-changing auth requests. Better Auth's own
		// origin/CSRF middleware never runs because `auth.api.*` bypasses its HTTP
		// router, leaving SameSite alone as CSRF defense. Non-browser callers that
		// omit Origin are unaffected.
		const method = request.method.toUpperCase();
		if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

		const origin = request.headers.get("origin");
		if (origin && !isOriginAllowed(origin)) {
			throw new ForbiddenError("Request origin is not allowed", { code: "auth.origin_denied" });
		}
	})
	.model({
		"auth.register.body": RegisterRequestSchema,
		"auth.register.response": RegisterResponseSchema,
		"auth.login.body": LoginRequestSchema,
		"auth.login.response": LoginResponseSchema,
		"auth.logout.response": LogoutResponseSchema,
		"auth.session.response": SessionResponseSchema,
	})
	.post("/register", async ({ body, request }) => await authService.register(body, request), {
		body: "auth.register.body",
		response: {
			200: "auth.register.response",
			400: "error.response",
			500: "error.response",
		},
		rateLimit: { name: "auth-register", max: 5, windowMs: 15 * MINUTE },
		detail: {
			description: "Create a new user account with email and password.",
		},
	})
	.post("/login", async ({ body, request }) => await authService.login(body, request), {
		body: "auth.login.body",
		response: { 200: "auth.login.response", ...ROUTE_ERRORS.AUTH, 500: "error.response" },
		rateLimit: { name: "auth-login", max: 5, windowMs: MINUTE },
		detail: {
			description: "Authenticate user and receive a session token.",
		},
	})
	.post(
		"/logout",
		async ({ request, cookie: { profile_unlock, current_profile_id } }) => {
			// A persisted unlock token must not survive logout — otherwise a later
			// login on the same browser could enter the PIN profile without the PIN.
			profile_unlock?.remove();
			current_profile_id?.remove();

			return await authService.logout(request);
		},
		{
			rateLimit: { name: "auth-logout", max: 30, windowMs: MINUTE },
			response: {
				200: "auth.logout.response",
				404: "error.response",
			},
			detail: {
				description: "Invalidate the current session and logout the user.",
			},
		},
	)
	.use(authMiddleware)
	.get(
		"/sessions",
		async ({ request, session, user, query }) => await sessionsService.list(request.headers, session?.id, user?.id, query),
		{
			query: PaginationSchema,
			response: { ...ROUTE_ERRORS.AUTH, 200: ActiveSessionsResponseSchema },
			rateLimit: { name: "auth-sessions-list", max: 60, windowMs: MINUTE },
			detail: { description: "List the authenticated user's active sessions without exposing session tokens." },
		},
	)
	.delete("/sessions", async ({ request, session, user }) => await sessionsService.revokeOthers(request.headers, session?.id, user?.id), {
		response: { ...ROUTE_ERRORS.AUTH, 200: "success.response" },
		rateLimit: { name: "auth-sessions-revoke-others", max: 30, windowMs: MINUTE },
		detail: { description: "Revoke every session except the current one." },
	})
	.delete(
		"/sessions/:sessionId",
		async ({ params, request, session, user }) => await sessionsService.revoke(params.sessionId, request.headers, session?.id, user?.id),
		{
			params: t.Object({ sessionId: t.String({ minLength: 1 }) }),
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "success.response" },
			rateLimit: { name: "auth-session-revoke", max: 60, windowMs: MINUTE },
			detail: { description: "Revoke one of the authenticated user's non-current sessions." },
		},
	);
