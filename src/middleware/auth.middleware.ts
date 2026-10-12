import type { Profile, Session, User } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { isImageAssetPath, isPluginUiPath } from "@/api/utils/route-classification.utils";
import { apiKeysService } from "@/application/admin/api-keys.service";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { usersRepository } from "@/database/repositories/users.repository";
import { env } from "@/env";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { getOrSetSession } from "@/integrations/better-auth/better-auth.session-cache";
import { serverConstants } from "@/server.constants";
import { DomainError } from "@/utils/errors";
import { getPathname } from "@/utils/http.utils";
import { createLogger } from "@/utils/logger";
import { isProfileUnlocked } from "@/utils/profile-unlock.utils";
import { isNonEmptyString } from "@/utils/type.utils";

const logger = createLogger("AuthMiddleware");
const AUTH_CREDENTIALS_REGEX = /(?:^|;\s*)(?:__Secure-|__Host-)?(?:better-auth\.|session_token=)/;
const SESSION_TOKEN_REGEX = /(?:^|;\s*)(?:__Secure-|__Host-)?better-auth\.session_token=([^;]+)/;

/** A ban without an expiry holds until it is lifted; a timed ban ends once its expiry has passed. */
function isBlockedAccount(user: { banned: boolean; banExpires?: Date | null | undefined }, now: Date): boolean {
	return user.banned && (!user.banExpires || user.banExpires.getTime() > now.getTime());
}

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

	const path = getPathname(request.url);
	if (isImageAssetPath(path)) return true;

	// Plugin UI assets are static bundle files (secret-free) imported cross-origin
	// as ESM modules — browsers omit credentials on those requests. The manifest
	// stays authenticated (it is role-filtered), as do plugin API routes.
	return isPluginUiPath(path) && path !== PLUGIN_UI_MANIFEST_PATH;
}

/**
 * Applies the profile-PIN lock uniformly across credential types: a
 * PIN-protected profile resolves to null unless the request carries a valid
 * signed unlock token. API keys are account-level credentials and can never
 * present a PIN, so they must not select a locked profile either.
 */
function resolveUnlockedProfile(ownedProfile: Profile | null, unlockToken: string | undefined): Profile | null {
	if (ownedProfile?.pin && !isProfileUnlocked(ownedProfile, unlockToken, env.BETTER_AUTH_SECRET)) return null;

	return ownedProfile;
}

interface AuthContext {
	user: User | null;
	session: Session | null;
	profile: Profile | null;
}

function anonymousAuth(): AuthContext {
	return { user: null, session: null, profile: null };
}

/**
 * The profile the request selects by cookie or header, if the account owns it. A PIN-protected
 * profile is locked within the account: selecting it without a signed unlock token yields no profile.
 */
async function resolveCurrentProfile(
	request: Request,
	selectedProfileId: unknown,
	unlockValue: unknown,
	userId: string,
): Promise<Profile | null> {
	const profileId = selectedProfileId ?? request.headers.get("x-profile-id");
	const rawProfile = typeof profileId === "string" ? ((await profilesRepository.findByPrimaryIdCached(profileId)) ?? null) : null;
	const ownedProfile: Profile | null = rawProfile?.userId === userId ? rawProfile : null;

	return resolveUnlockedProfile(ownedProfile, typeof unlockValue === "string" ? unlockValue : undefined);
}

async function authenticateApiKey(
	request: Request,
	apiKey: string,
	selectedProfileId: unknown,
	unlockValue: unknown,
): Promise<AuthContext> {
	const principal = await apiKeysService.authenticate(apiKey);
	if (!principal) return anonymousAuth();

	if (request.method !== "GET" && principal.scope === "read_only") {
		throw new DomainError("forbidden", "This API key is read-only", { code: "api_key.read_only" });
	}

	const profile = await resolveCurrentProfile(request, selectedProfileId, unlockValue, principal.user.id);

	// Full owner record — guards and audit consumers read role/ban state. A blocked owner
	// loses the key at once, the same way a blocked account loses its sessions.
	const user = await usersRepository.findById(principal.user.id);
	if (!user || isBlockedAccount(user, new Date())) return anonymousAuth();

	return { user, session: null, profile };
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
				return anonymousAuth();
			}

			// Machine integration keys short-circuit before better-auth: the key is
			// its own credential and the principal is the admin who created it.
			const apiKeyHeader = request.headers.get("x-api-key");
			if (apiKeyHeader?.startsWith("rv_")) {
				return await authenticateApiKey(request, apiKeyHeader, current_profile_id?.value, profile_unlock?.value);
			}

			if (!hasAuthCredentials(request.headers)) {
				return anonymousAuth();
			}

			// `disableCookieCache` forces a DB read: the signed session cookie cache
			// would otherwise mask revocation, bans, role changes and password resets
			// for up to 5 minutes (a demoted admin kept `role:"admin"`). The 5 s
			// in-memory cache below keeps that guarantee while avoiding a DB read per
			// HLS segment.
			const sessionToken = extractSessionToken(request.headers);
			const session = sessionToken
				? await getOrSetSession(sessionToken, () =>
						betterAuthApi.getSession({ headers: request.headers, query: { disableCookieCache: true } }),
					)
				: await betterAuthApi.getSession({ headers: request.headers, query: { disableCookieCache: true } });
			if (!session) {
				logger.debug("Missing session", {
					method: request.method,
					url: request.url,
				});

				return anonymousAuth();
			}

			const user = toUser(session.user);

			return {
				user,
				session: toSession(session.session),
				profile: await resolveCurrentProfile(request, current_profile_id?.value, profile_unlock?.value, user.id),
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
					throw new DomainError("forbidden", "Admin access required", { code: "auth.admin_required" });
				}
			},
		}),
		profileRequired: (required: boolean) => ({
			beforeHandle({ user, profile }) {
				if (!required) return;

				requireUser(user);
				if (!profile) {
					logger.debug("Active profile required");
					throw new DomainError("unauthorized", "Active profile required", { code: "auth.profile_required" });
				}
			},
		}),
	});

export function requireUser(user: User | null): asserts user is User {
	if (!user) {
		logger.debug("Session expired or invalid");
		throw new DomainError("unauthorized", "Session expired or invalid", { code: "auth.session_invalid" });
	}
}

/** Narrows the derived user for handler bodies after the `adminOnly` macro guard. */
export function requireAdmin(user: User | null): asserts user is User {
	requireUser(user);
	if (user.role !== "admin") {
		logger.debug("Admin access required");
		throw new DomainError("forbidden", "Admin access required", { code: "auth.admin_required" });
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
		throw new DomainError("internal", "Better Auth returned an invalid user timestamp", { code: "auth.invalid_timestamp" });

	return date;
}

function hasAuthCredentials(headers: Headers): boolean {
	if (headers.get("authorization") || headers.get("x-api-key")) return true;

	const cookie = headers.get("cookie");
	if (!cookie) return false;

	// Handles both plain HTTP (no prefix) and HTTPS (__Secure- / __Host-) cookie variants
	return AUTH_CREDENTIALS_REGEX.test(cookie);
}
