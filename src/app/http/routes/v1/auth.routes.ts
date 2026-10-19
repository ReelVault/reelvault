import {
	ActiveSessionsResponseSchema,
	ChangePasswordRequestSchema,
	ChangePasswordResponseSchema,
	LoginRequestSchema,
	LoginResponseSchema,
	LogoutResponseSchema,
	RegisterRequestSchema,
	RegisterResponseSchema,
	SessionResponseSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { authService } from "@/app/auth/auth.service";
import { sessionsService } from "@/app/auth/sessions.service";
import { authMiddleware } from "@/app/http/middleware/auth.middleware";
import { assertAuthRequestOrigin } from "@/app/http/middleware/auth-origin.guard";
import { rateLimitMiddleware } from "@/app/http/middleware/rate-limit.middleware";
import { commonModel, PaginationSchema, ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { MINUTE } from "@/config/server/server.constants";
import { quickConnectRoutes } from "./quick-connect.routes";

export const authRoutes = new Elysia({
	prefix: "/auth",
	tags: ["Auth"],
})
	.use(commonModel)
	.use(rateLimitMiddleware)
	// Declared before the child plugin: hooks apply only to routes registered
	// after them, and quick-connect endpoints are state-changing auth requests.
	.onBeforeHandle(({ request }) => assertAuthRequestOrigin(request))
	.use(quickConnectRoutes)
	.model({
		"auth.register.body": RegisterRequestSchema,
		"auth.register.response": RegisterResponseSchema,
		"auth.login.body": LoginRequestSchema,
		"auth.login.response": LoginResponseSchema,
		"auth.change_password.body": ChangePasswordRequestSchema,
		"auth.change_password.response": ChangePasswordResponseSchema,
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
	.post("/change-password", async ({ body, request }) => await authService.changePassword(body, request), {
		body: "auth.change_password.body",
		response: { ...ROUTE_ERRORS.AUTH, 200: "auth.change_password.response", 400: "error.response" },
		rateLimit: { name: "auth-change-password", max: 5, windowMs: 15 * MINUTE },
		detail: { description: "Change the signed-in user's password. Every other session is revoked; the current one stays signed in." },
	})
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
			response: { ...ROUTE_ERRORS.AUTH, 403: "error.response", 404: "error.response", 200: "success.response" },
			rateLimit: { name: "auth-session-revoke", max: 60, windowMs: MINUTE },
			detail: { description: "Revoke one of the authenticated user's non-current sessions." },
		},
	);
