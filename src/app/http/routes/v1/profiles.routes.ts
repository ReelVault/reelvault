import {
	CopyProfilePreferencesSchema,
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
import { authMiddleware } from "@/app/http/middleware/auth.middleware";
import { rateLimitMiddleware, routeLimit } from "@/app/http/middleware/rate-limit.middleware";
import { commonModel, listQuerySchema, PaginatedResponseSchema, ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { IdParams } from "@/app/http/schemas/route-params.schema";
import { profilesService } from "@/app/users/profiles.service";
import { serverConfig } from "@/config/server/server.config";
import { getCookieDomainFromOrigin } from "@/utils/cookie-domain.utils";

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
		query: listQuerySchema({ filters: ProfileFiltersSchema, sorting: ProfileSortingSchema }),
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
		params: IdParams,
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "profile.schema" },
		detail: {
			description: "Retrieve detailed information about a specific profile by its ID.",
		},
	})
	.patch("/:id", async ({ params, body, query, user }) => await profilesService.update(params.id, body, query, user?.id), {
		params: IdParams,
		body: "profile.update.body",
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "profile.schema" },
		detail: {
			description: "Modify an existing profile's settings or information.",
		},
	})
	.delete(
		"/:id",
		async ({ params, user, profile, cookie: { current_profile_id, profile_unlock } }) => {
			const result = await profilesService.delete(params.id, user?.id);
			// Deleting the profile this client is acting as must not leave its id (and PIN unlock proof)
			// in cookies — every later request would otherwise resolve a profile that no longer exists.
			if (profile?.id === params.id) {
				current_profile_id?.remove();
				profile_unlock?.remove();
			}

			return result;
		},
		{
			params: IdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Permanently remove a profile from the account.",
			},
		},
	)
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

			const isNativeShell = request.headers.get("x-client-shell") === "native";

			return {
				success: results.success,
				// Browser clients unlock via the Set-Cookie pair only; native shells
				// cannot read Set-Cookie reliably and replay the token as a Cookie
				// header instead — same escape hatch as quick-connect redeem.
				...(results.unlockToken && isNativeShell ? { unlockToken: results.unlockToken } : {}),
			};
		},
		{
			// PIN verification runs argon2id — cap attempts per account (middleware
			// identity is userId when no profile is active) to slow brute force.
			rateLimit: routeLimit("profile-switch", 10, 15 * 60_000),
			body: "profile.switch.body",
			response: {
				...ROUTE_ERRORS.VALIDATED,
				200: t.Object({ success: t.Boolean(), unlockToken: t.Optional(t.String()) }),
			},
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
	.get("/:id/pin", async ({ params, user }) => await profilesService.hasPin(params.id, user?.id), {
		params: IdParams,
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: t.Object({ hasPin: t.Boolean() }) },
		detail: { description: "Whether the authenticated user's profile has a PIN set. The PIN itself is never returned." },
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
	.post(
		"/:id/preferences/copy",
		async ({ params, body, user }) => await profilesService.copyPreferences(params.id, body.sourceProfileId, user?.id),
		{
			body: CopyProfilePreferencesSchema,
			response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "profile.preferences" },
			detail: {
				description: "Replace this profile's preference overrides with a copy of another profile's, both owned by the same account.",
			},
		},
	)
	.delete("/:id/preferences", async ({ params, user }) => await profilesService.resetPreferences(params.id, user?.id), {
		params: IdParams,
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "profile.preferences" },
		detail: { description: "Reset preferences to server defaults by removing all stored overrides." },
	});
