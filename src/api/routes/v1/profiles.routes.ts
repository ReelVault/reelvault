import {
	CreateProfileSchema,
	ProfileFiltersSchema,
	ProfilePreferenceDefaultsSchema,
	ProfilePreferencesSchema,
	ProfileSchema,
	ProfileSortingSchema,
	ProjectedResponseSchema,
	SwitchProfileSchema,
	UpdateProfilePreferencesSchema,
	UpdateProfileSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { IdParams } from "@/api/schemas/route-params";
import { profilesService } from "@/application/users/profiles.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { serverConfig } from "@/server.config";
import { getCookieDomainFromOrigin } from "@/utils/http.utils";

export const profilesRoutes = new Elysia({
	prefix: "/profiles",
	tags: ["Profiles"],
})
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"profile.schema": ProjectedResponseSchema(ProfileSchema),
		"profiles.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(ProfileSchema)),
		"profile.create.body": CreateProfileSchema,
		"profile.update.body": UpdateProfileSchema,
		"profile.preferences": ProfilePreferencesSchema,
		"profile.preferences.update.body": UpdateProfilePreferencesSchema,
		"profile.preferences.defaults": ProfilePreferenceDefaultsSchema,
		"profile.switch.body": SwitchProfileSchema,
	})
	.guard({ auth: true })
	.get("/", async ({ user, query }) => await profilesService.getAll(query, user?.id), {
		query: t.Composite([PaginationSchema, FieldsSchema, ProfileFiltersSchema, ProfileSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "profiles.paginated.schema" },
		detail: {
			description: "Retrieve all profiles associated with the authenticated user account.",
		},
	})
	.post("/", async ({ body, query, user }) => await profilesService.create(body, query, user?.id), {
		body: "profile.create.body",
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.VALIDATED, 201: "profile.schema" },
		detail: {
			description: "Create a new profile for the authenticated account.",
		},
	})
	.get("/:id", async ({ params, query, user }) => await profilesService.getById(params.id, query, user?.id), {
		params: t.Object({
			id: t.String(),
		}),
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "profile.schema" },
		detail: {
			description: "Retrieve detailed information about a specific profile by its ID.",
		},
	})
	.patch("/:id", async ({ params, body, query, user }) => await profilesService.update(params.id, body, query, user?.id), {
		params: t.Object({
			id: t.String(),
		}),
		body: "profile.update.body",
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "profile.schema" },
		detail: {
			description: "Modify an existing profile's settings or information.",
		},
	})
	.delete("/:id", async ({ params, user }) => await profilesService.delete(params.id, user?.id), {
		params: t.Object({
			id: t.String(),
		}),
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
		detail: {
			description: "Permanently remove a profile from the account.",
		},
	})
	.post(
		"/switch",
		async ({ body, cookie: { current_profile_id, profile_unlock }, request, user }) => {
			const results = await profilesService.switch(body, user?.id);
			const cookieDomain = getCookieDomainFromOrigin(request.headers.get("origin"));
			current_profile_id?.set({
				value: body.profileId,
				httpOnly: true,
				secure: serverConfig.auth.secureCookies,
				sameSite: "lax",
				path: "/",
				maxAge: 7 * 86400,
				domain: cookieDomain,
			});
			if (results.unlockToken) {
				profile_unlock?.set({
					value: results.unlockToken,
					httpOnly: true,
					secure: serverConfig.auth.secureCookies,
					sameSite: "lax",
					path: "/",
					maxAge: 12 * 60 * 60,
					domain: cookieDomain,
				});
			} else {
				profile_unlock?.remove();
			}

			return { success: results.success };
		},
		{
			// PIN verification runs argon2id — cap attempts per account (middleware
			// identity is userId when no profile is active) to slow brute force.
			rateLimit: { name: "profile-switch", max: 10, windowMs: 15 * 60_000 },
			body: "profile.switch.body",
			response: { ...ROUTE_ERRORS.VALIDATED, 200: "success.response" },
			detail: {
				description: "Switch the active profile for the current session. Updates the session cookie.",
			},
		},
	)
	.post("/:id/avatar", async ({ params, body, user }) => await profilesService.uploadAvatar(params.id, body.file, user?.id), {
		params: IdParams,
		body: t.Object({ file: t.File({ type: "image/*", maxSize: "2m" }) }),
		response: {
			...ROUTE_ERRORS.VALIDATED_NOT_FOUND,
			200: t.Object({ avatarUrl: t.String() }),
		},
		detail: {
			description: "Upload, optimize and set a custom avatar image for the profile.",
		},
	})
	.get("/preferences/defaults", () => profilesService.getPreferenceDefaults(), {
		response: { ...ROUTE_ERRORS.AUTH, 200: "profile.preferences.defaults" },
		detail: { description: "Server defaults a profile falls back to when it has no stored preference overrides." },
	})
	.get("/:id/preferences", async ({ params, user }) => await profilesService.getPreferences(params.id, user?.id), {
		params: IdParams,
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "profile.preferences" },
		detail: { description: "Retrieve preferences for an authenticated user's profile." },
	})
	.patch("/:id/preferences", async ({ params, body, user }) => await profilesService.updatePreferences(params.id, body, user?.id), {
		params: IdParams,
		body: "profile.preferences.update.body",
		response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "profile.preferences" },
		detail: { description: "Update preferences for an authenticated user's profile. Accepts a partial delta." },
	})
	.delete("/:id/preferences", async ({ params, user }) => await profilesService.resetPreferences(params.id, user?.id), {
		params: IdParams,
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "profile.preferences" },
		detail: { description: "Reset preferences to server defaults by removing all stored overrides." },
	});
