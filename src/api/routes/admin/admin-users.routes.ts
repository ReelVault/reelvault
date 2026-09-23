import {
	AdminCreateUserProfileSchema,
	AdminCreateUserSchema,
	AdminSetUserPasswordSchema,
	AdminUserProfileSchema,
	AdminUserSchema,
	AdminUsersPageSchema,
	ProfilePreferencesSchema,
	SuccessResponseSchema,
	UpdateProfilePreferencesSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { ClampedNumeric, commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { UserIdParams, UserProfileIdParams } from "@/api/schemas/route-params";
import { adminUsersService } from "@/application/admin/admin-users.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

export const adminUsersRoutes = new Elysia()
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
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
	.guard({ adminOnly: true })
	.get("/users", async ({ query }) => await adminUsersService.getAll(query), {
		rateLimit: { name: "admin-users-list", max: 120, windowMs: 60_000 },
		query: t.Object({
			search: t.Optional(t.String({ maxLength: 200 })),
			page: t.Optional(t.Numeric({ minimum: 1 })),
			limit: t.Optional(ClampedNumeric(1, 100)),
		}),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.usersPage" },
		detail: { description: "List user accounts for administration." },
	})
	.post("/users", async ({ body, user, request }) => await adminUsersService.create(body, user?.id, request.headers), {
		rateLimit: { name: "admin-users-create", max: 10, windowMs: 60_000 },
		body: "admin.createUser",
		response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_CONFLICT, 200: "admin.user" },
		detail: { description: "Create a new user account as an administrator." },
	})
	.get("/users/:userId", async ({ params }) => await adminUsersService.getById(params.userId), {
		rateLimit: { name: "admin-users-get", max: 120, windowMs: 60_000 },
		params: UserIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.user" },
		detail: { description: "Retrieve an account for administration." },
	})
	.get("/users/:userId/full", async ({ params }) => await adminUsersService.getByIdWithProfiles(params.userId), {
		rateLimit: { name: "admin-users-get-full", max: 120, windowMs: 60_000 },
		params: UserIdParams,
		response: {
			...ROUTE_ERRORS.ADMIN_NOT_FOUND,
			200: t.Object({ user: AdminUserSchema, profiles: t.Array(AdminUserProfileSchema) }),
		},
		detail: { description: "Retrieve user account and profiles in one call." },
	})
	.get("/users/:userId/profiles", async ({ params }) => await adminUsersService.getProfiles(params.userId), {
		rateLimit: { name: "admin-users-profiles-list", max: 120, windowMs: 60_000 },
		params: UserIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: t.Array(AdminUserProfileSchema) },
		detail: { description: "List profiles belonging to an account without exposing PIN values." },
	})
	.post(
		"/users/:userId/profiles",
		async ({ params, body, user, request }) => await adminUsersService.createProfile(params.userId, body, user?.id, request.headers),
		{
			rateLimit: { name: "admin-users-profiles-create", max: 30, windowMs: 60_000 },
			params: UserIdParams,
			body: "admin.createUserProfile",
			response: {
				200: "admin.userProfile",
				400: "error.response",
				401: "error.response",
				403: "error.response",
				404: "error.response",
				409: "error.response",
			},
			detail: { description: "Create a profile for a user account as an administrator." },
		},
	)
	.get(
		"/users/:userId/profiles/:profileId/preferences",
		async ({ params }) => await adminUsersService.getProfilePreferences(params.userId, params.profileId),
		{
			rateLimit: { name: "admin-users-prefs-get", max: 120, windowMs: 60_000 },
			params: UserProfileIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.userProfilePreferences" },
			detail: { description: "Retrieve a user profile's preferences as an administrator." },
		},
	)
	.patch(
		"/users/:userId/profiles/:profileId/preferences",
		async ({ params, body, user, request }) =>
			await adminUsersService.updateProfilePreferences(params.userId, params.profileId, body, user?.id, request.headers),
		{
			rateLimit: { name: "admin-users-prefs-update", max: 30, windowMs: 60_000 },
			params: UserProfileIdParams,
			body: "admin.userProfilePreferencesUpdate",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.userProfilePreferences" },
			detail: { description: "Update a user profile's preferences as an administrator." },
		},
	)
	.delete(
		"/users/:userId/profiles/:profileId/preferences",
		async ({ params, user, request }) =>
			await adminUsersService.resetProfilePreferences(params.userId, params.profileId, user?.id, request.headers),
		{
			rateLimit: { name: "admin-users-prefs-reset", max: 10, windowMs: 60_000 },
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
			await adminUsersService.updateProfile(params.userId, params.profileId, body, user?.id, request.headers),
		{
			rateLimit: { name: "admin-users-profile-update", max: 30, windowMs: 60_000 },
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
		async ({ params, user, request }) => await adminUsersService.deleteProfile(params.userId, params.profileId, user?.id, request.headers),
		{
			rateLimit: { name: "admin-users-profile-delete", max: 10, windowMs: 60_000 },
			params: UserProfileIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: SuccessResponseSchema },
			detail: { description: "Delete a user's profile as an administrator." },
		},
	)
	.patch(
		"/users/:userId",
		async ({ params, body, user, request }) => await adminUsersService.update(params.userId, body, user?.id, request.headers),
		{
			rateLimit: { name: "admin-users-update", max: 30, windowMs: 60_000 },
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
		async ({ params, body, user, request }) => await adminUsersService.setPassword(params.userId, body, user?.id, request.headers),
		{
			rateLimit: { name: "admin-users-set-password", max: 10, windowMs: 60_000 },
			params: UserIdParams,
			body: "admin.setUserPassword",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "success.response" },
			detail: { description: "Set a user account's password as an administrator." },
		},
	)
	.delete("/users/:userId", async ({ params, user, request }) => await adminUsersService.delete(params.userId, user?.id, request.headers), {
		rateLimit: { name: "admin-users-delete", max: 10, windowMs: 60_000 },
		params: UserIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: SuccessResponseSchema },
		detail: { description: "Permanently delete an account and its cascaded profiles, sessions, and account data." },
	});
