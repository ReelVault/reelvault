import type { Profile, Session, User } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { isImageAssetPath, isPluginUiPath } from "@/api/utils/route-classification.utils";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { env } from "@/env";
import { auth } from "@/integrations/better-auth/better-auth.config";
import { getOrSetSession } from "@/integrations/better-auth/better-auth.session-cache";
import { serverConstants } from "@/server.constants";
import { ForbiddenError, InternalError, UnauthorizedError } from "@/utils/errors";
import { getPathname } from "@/utils/http.utils";
import { createLogger } from "@/utils/logger";
import { isProfileUnlocked } from "@/utils/profile-unlock.utils";
import { isNonEmptyString } from "@/utils/type.utils";

const logger = createLogger("AuthMiddleware");
const AUTH_CREDENTIALS_REGEX = /(?:^|;\s*)(?:__Secure-|__Host-)?(?:better-auth\.|session_token=)/;
const SESSION_TOKEN_REGEX = /(?:^|;\s*)(?:__Secure-|__Host-)?better-auth\.session_token=([^;]+)/;

function extractSessionToken(headers: Headers): string | undefined {
	const cookie = headers.get("cookie");
	if (!cookie) return undefined;

	const match = SESSION_TOKEN_REGEX.exec(cookie);

	return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * GET prefixes that are public by design (rate limiter exempts them too).
 * The derive is global, so without this early-out every poster/backdrop request
 * paid full session verification + profile lookup — a catalog grid loads
 * dozens of images per view, each carrying the session cookie.
 */
const PLUGIN_UI_MANIFEST_PATH = `${serverConstants.security.pluginUiRoutePrefix}manifest`;

function isPublicGet(request: Request): boolean {
	if (request.method !== "GET") return false;

	if (isImageAssetPath(request.url)) return true;

	// Plugin UI assets are static bundle files (secret-free) imported cross-origin
	// as ESM modules — browsers omit credentials on those requests. The manifest
	// stays authenticated (it is role-filtered), as do plugin API routes.
	const path = getPathname(request.url);

	return isPluginUiPath(request.url) && path !== PLUGIN_UI_MANIFEST_PATH;
}

export const authMiddleware = new Elysia({ name: "AuthMiddleware" })
	.derive(
		{ as: "global" },
		async ({
			request,
			cookie: { current_profile_id, profile_unlock },
		}): Promise<{
			user: User | null;
			session: Session | null;
			profile: Profile | null;
		}> => {
			if (isPublicGet(request)) {
				return { user: null, session: null, profile: null };
			}

			if (!hasAuthCredentials(request.headers)) {
				return { user: null, session: null, profile: null };
			}

			// `disableCookieCache` forces a DB read: the signed session cookie cache
			// would otherwise mask revocation, bans, role changes and password resets
			// for up to 5 minutes (a demoted admin kept `role:"admin"`). The 5 s
			// in-memory cache below keeps that guarantee while avoiding a DB read per
			// HLS segment.
			const sessionToken = extractSessionToken(request.headers);
			const session = sessionToken
				? await getOrSetSession(sessionToken, () => auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } }))
				: await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
			if (!session) {
				logger.debug("Missing session", {
					method: request.method,
					url: request.url,
				});

				return { user: null, session: null, profile: null };
			}

			const profileId = current_profile_id?.value ?? request.headers.get("x-profile-id");
			const rawProfile = typeof profileId === "string" ? ((await profilesRepository.findByPrimaryIdCached(profileId)) ?? null) : null;

			const user = toUser(session.user);
			const ownedProfile: Profile | null = rawProfile && rawProfile.userId === user.id ? rawProfile : null;

			// A PIN-protected profile is locked within the account: selecting it via
			// `x-profile-id` or `current_profile_id` without a signed unlock token
			// yields no active profile (the client must switch in and enter the PIN).
			let currentProfile = ownedProfile;
			if (ownedProfile?.pin) {
				const unlockToken = typeof profile_unlock?.value === "string" ? profile_unlock.value : undefined;
				// The fingerprint binds the token to the current PIN hash: adding or
				// changing the PIN invalidates any token issued before the change.
				if (!isProfileUnlocked(ownedProfile, unlockToken, env.BETTER_AUTH_SECRET)) currentProfile = null;
			}

			return {
				user,
				session: toSession(session.session),
				profile: currentProfile,
			};
		},
	)
	.macro({
		auth: (required: boolean) => ({
			beforeHandle({ user }) {
				if (required) requireUser(user);
			},
		}),
		adminOnly: (required: boolean) => ({
			beforeHandle({ user }) {
				if (!required) return;

				requireUser(user);
				if (user.role !== "admin") {
					logger.debug("Admin access required");
					throw new ForbiddenError("Admin access required", { code: "auth.admin_required" });
				}
			},
		}),
		profileRequired: (required: boolean) => ({
			beforeHandle({ user, profile }) {
				if (!required) return;

				requireUser(user);
				if (!profile) {
					logger.debug("Active profile required");
					throw new UnauthorizedError("Active profile required", { code: "auth.profile_required" });
				}
			},
		}),
	});

function requireUser(user: User | null): asserts user is User {
	if (!user) {
		logger.debug("Session expired or invalid");
		throw new UnauthorizedError("Session expired or invalid", { code: "auth.session_invalid" });
	}
}

function toUser(value: Record<string, unknown>): User {
	const banExpires = value.banExpires;

	return {
		id: String(value.id),
		createdAt: toDate(value.createdAt),
		updatedAt: toDate(value.updatedAt),
		name: String(value.name),
		email: String(value.email),
		emailVerified: value.emailVerified === true,
		image: isNonEmptyString(value.image) ? value.image : null,
		role: isNonEmptyString(value.role) ? value.role : "user",
		banned: value.banned === true,
		banReason: isNonEmptyString(value.banReason) ? value.banReason : null,
		banExpires: banExpires instanceof Date ? banExpires : null,
		twoFactorEnabled: value.twoFactorEnabled === true,
	};
}

function toSession(value: Record<string, unknown>): Session {
	const now = new Date();

	return {
		id: typeof value.id === "string" ? value.id : "",
		createdAt: value.createdAt ? toDate(value.createdAt) : now,
		updatedAt: value.updatedAt ? toDate(value.updatedAt) : now,
		userId: typeof value.userId === "string" ? value.userId : "",
		token: typeof value.token === "string" ? value.token : "",
		ipAddress: isNonEmptyString(value.ipAddress) ? value.ipAddress : null,
		userAgent: isNonEmptyString(value.userAgent) ? value.userAgent : null,
		impersonatedBy: isNonEmptyString(value.impersonatedBy) ? value.impersonatedBy : null,
		expiresAt: value.expiresAt ? toDate(value.expiresAt) : now,
	};
}

function toDate(value: unknown): Date {
	if (value instanceof Date) return value;

	const date = new Date(String(value));
	if (Number.isNaN(date.getTime()))
		throw new InternalError("Better Auth returned an invalid user timestamp", { code: "auth.invalid_timestamp" });

	return date;
}

function hasAuthCredentials(headers: Headers): boolean {
	if (headers.get("authorization")) return true;

	const cookie = headers.get("cookie");
	if (!cookie) return false;

	// Handles both plain HTTP (no prefix) and HTTPS (__Secure- / __Host-) cookie variants
	return AUTH_CREDENTIALS_REGEX.test(cookie);
}
