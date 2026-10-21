import {
	AdminCreateUserProfileSchema,
	AdminCreateUserSchema,
	AdminSetUserPasswordSchema,
	AdminUserProfileSchema,
	AdminUserSchema,
	AdminUserSessionsPageSchema,
	AdminUsersPageSchema,
	ProfilePreferencesSchema,
	RevokeUsersSessionsResultSchema,
	RevokeUsersSessionsSchema,
	SuccessResponseSchema,
	UpdateProfilePreferencesSchema,
} from "@reelvault/sdk/common";
import { t } from "elysia";
import { routeLimit } from "@/api/middleware/rate-limit.middleware";
import { PaginationQuerySchema, paginationQueryFields, ROUTE_ERRORS } from "@/api/schemas/common.schema";
import { UserIdParams, UserProfileIdParams, UserSessionParams } from "@/api/schemas/route-params.schema";
import { actorContext } from "@/api/utils/audit-context.utils";
import { adminUsersService } from "@/services/admin/admin-users.service";
import { adminShell } from "./admin-shell.routes";

export const adminUsersRoutes = adminShell({ tags: ["Admin"] })
	.model({
		"admin.user": AdminUserSchema,
		"admin.userProfile": AdminUserProfileSchema,
		"admin.usersPage": AdminUsersPageSchema,
		"admin.createUser": AdminCreateUserSchema,
		"admin.createUserProfile": AdminCreateUserProfileSchema,
		"admin.setUserPassword": AdminSetUserPasswordSchema,
		"admin.userProfilePreferences": ProfilePreferencesSchema,
		"admin.userProfilePreferencesUpdate": UpdateProfilePreferencesSchema,
	})
	.get("/users", async ({ query }) => await adminUsersService.getAll(query), {
		rateLimit: routeLimit("admin-users-list", 120),
		query: t.Object({
			q: t.Optional(t.String({ maxLength: 200 })),
			role: t.Optional(t.Union([t.Literal("admin"), t.Literal("user")])),
			status: t.Optional(t.Union([t.Literal("active"), t.Literal("blocked")])),
			...paginationQueryFields({ maxLimit: 100 }),
		}),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.usersPage" },
		detail: { description: "List user accounts for administration." },
	})
	.post(
		"/users",
		async ({ body, user, request, status }) => status(201, await adminUsersService.create(body, actorContext({ user, request }))),
		{
			rateLimit: routeLimit("admin-users-create", 10),
			body: "admin.createUser",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 409: "error.response", 201: "admin.user" },
			detail: { description: "Create a new user account as an administrator." },
		},
	)
	.get("/users/:userId", async ({ params }) => await adminUsersService.getById(params.userId), {
		rateLimit: routeLimit("admin-users-get", 120),
		params: UserIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.user" },
		detail: { description: "Retrieve an account for administration." },
	})
	.get("/users/:userId/full", async ({ params }) => await adminUsersService.getByIdWithProfiles(params.userId), {
		rateLimit: routeLimit("admin-users-get-full", 120),
		params: UserIdParams,
		response: {
			...ROUTE_ERRORS.ADMIN_NOT_FOUND,
			200: t.Object({ user: AdminUserSchema, profiles: t.Array(AdminUserProfileSchema) }),
		},
		detail: { description: "Retrieve user account and profiles in one call." },
	})
	.get("/users/:userId/sessions", async ({ params, query }) => await adminUsersService.getSessions(params.userId, query), {
		params: UserIdParams,
		query: t.Optional(PaginationQuerySchema({ maxLimit: 100, defaultLimit: 25, defaultPage: 1 })),
		rateLimit: routeLimit("admin-user-sessions", 60),
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: AdminUserSessionsPageSchema },
		detail: {
			description: "List a user's sessions that have not expired: device, address and times. Tokens are never included.",
		},
	})
	.delete(
		"/users/:userId/sessions/:sessionId",
		async ({ params, user, request }) => {
			await adminUsersService.revokeSession(params.userId, params.sessionId, actorContext({ user, request }));

			return { success: true };
		},
		{
			params: UserSessionParams,
			rateLimit: routeLimit("admin-user-session-revoke", 60),
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: SuccessResponseSchema },
			detail: {
				description: "End one of a user's sessions. The session is signed out on its next request.",
			},
		},
	)
	.post(
		"/users/sessions/revoke",
		async ({ body, user, request }) => await adminUsersService.revokeSessionsForUsers(body.userIds, actorContext({ user, request })),
		{
			body: RevokeUsersSessionsSchema,
			rateLimit: routeLimit("admin-user-sessions-revoke", 10),
			response: { ...ROUTE_ERRORS.ADMIN, 200: RevokeUsersSessionsResultSchema },
			detail: {
				description: "End every session of several users at once (up to 100 users). The change is audited.",
			},
		},
	)
	.get("/users/:userId/profiles", async ({ params }) => await adminUsersService.getProfiles(params.userId), {
		rateLimit: routeLimit("admin-users-profiles-list", 120),
		params: UserIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: t.Array(AdminUserProfileSchema) },
		detail: { description: "List profiles belonging to an account without exposing PIN values." },
	})
	.post(
		"/users/:userId/profiles",
		async ({ params, body, user, request }) => await adminUsersService.createProfile(params.userId, body, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-users-profiles-create", 30),
			params: UserIdParams,
			body: "admin.createUserProfile",
			response: { 200: "admin.userProfile", ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 409: "error.response" },
			detail: { description: "Create a profile for a user account as an administrator." },
		},
	)
	.get(
		"/users/:userId/profiles/:profileId/preferences",
		async ({ params }) => await adminUsersService.getProfilePreferences(params.userId, params.profileId),
		{
			rateLimit: routeLimit("admin-users-prefs-get", 120),
			params: UserProfileIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.userProfilePreferences" },
			detail: { description: "Retrieve a user profile's preferences as an administrator." },
		},
	)
	.patch(
		"/users/:userId/profiles/:profileId/preferences",
		async ({ params, body, user, request }) =>
			await adminUsersService.updateProfilePreferences(params.userId, params.profileId, body, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-users-prefs-update", 30),
			params: UserProfileIdParams,
			body: "admin.userProfilePreferencesUpdate",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.userProfilePreferences" },
			detail: { description: "Update a user profile's preferences as an administrator." },
		},
	)
	.delete(
		"/users/:userId/profiles/:profileId/preferences",
		async ({ params, user, request }) =>
			await adminUsersService.resetProfilePreferences(params.userId, params.profileId, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-users-prefs-reset", 10),
			params: UserProfileIdParams,
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.userProfilePreferences" },
			detail: {
				description: "Reset a user profile's preferences to server defaults by removing all stored overrides.",
			},
		},
	)
	.patch(
		"/users/:userId/profiles/:profileId",
		async ({ params, body, user, request }) =>
			await adminUsersService.updateProfile(params.userId, params.profileId, body, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-users-profile-update", 30),
			params: UserProfileIdParams,
			body: t.Object({
				name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
				avatarUrl: t.Optional(t.Nullable(t.String({ maxLength: 2048 }))),
				pin: t.Optional(t.Nullable(t.String({ minLength: 4, maxLength: 32 }))),
			}),
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.userProfile" },
			detail: { description: "Update a user's profile as an administrator." },
		},
	)
	.delete(
		"/users/:userId/profiles/:profileId",
		async ({ params, user, request }) =>
			await adminUsersService.deleteProfile(params.userId, params.profileId, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-users-profile-delete", 10),
			params: UserProfileIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: SuccessResponseSchema },
			detail: { description: "Delete a user's profile as an administrator." },
		},
	)
	.patch(
		"/users/:userId",
		async ({ params, body, user, request }) => await adminUsersService.update(params.userId, body, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-users-update", 30),
			params: UserIdParams,
			body: t.Object({
				role: t.Optional(t.Union([t.Literal("admin"), t.Literal("user")])),
				banned: t.Optional(t.Boolean()),
				banReason: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
			}),
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.user" },
			detail: { description: "Change a user's role or account block status." },
		},
	)
	.post(
		"/users/:userId/password",
		async ({ params, body, user, request }) => await adminUsersService.setPassword(params.userId, body, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-users-set-password", 10),
			params: UserIdParams,
			body: "admin.setUserPassword",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "success.response" },
			detail: { description: "Set a user account's password as an administrator." },
		},
	)
	.delete(
		"/users/:userId",
		async ({ params, user, request }) => await adminUsersService.delete(params.userId, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-users-delete", 10),
			params: UserIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: SuccessResponseSchema },
			detail: { description: "Permanently delete an account and its cascaded profiles, sessions, and account data." },
		},
	);
