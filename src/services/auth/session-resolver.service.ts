import type { Profile, Session, User } from "@reelvault/sdk/common";
import { env } from "@/config/env.config";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { getOrSetSession } from "@/integrations/better-auth/better-auth.session-cache";
import { profilesRepository } from "@/repositories/profiles.repository";
import { usersRepository } from "@/repositories/users.repository";
import { apiKeysService } from "@/services/admin/api-keys.service";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { isProfileUnlocked } from "@/utils/profile-unlock.utils";
import { isNonEmptyString } from "@/utils/type.utils";

const logger = createLogger("SessionResolver");
const AUTH_CREDENTIALS_REGEX = /(?:^|;\s*)(?:__Secure-|__Host-)?(?:better-auth\.|session_token=)/;
const SESSION_TOKEN_REGEX = /(?:^|;\s*)(?:__Secure-|__Host-)?better-auth\.session_token=([^;]+)/;

/**
 * The principal behind a request: the account, its session and the selected profile.
 * It extends `Record<string, unknown>` because Elysia's `derive` needs the
 * returned context to carry an index signature.
 */
export interface ResolvedSession {
	user: User | null;
	session: Session | null;
	profile: Profile | null;
}

/** A ban without an expiry holds until it is lifted; a timed ban ends once its expiry has passed. */
function isBlockedAccount(user: { banned: boolean; banExpires?: Date | null | undefined }, now: Date): boolean {
	return user.banned && (!user.banExpires || user.banExpires.getTime() > now.getTime());
}

function extractSessionToken(headers: Headers): string | undefined {
	const cookie = headers.get("cookie");
	if (!cookie) return undefined;

	const match = SESSION_TOKEN_REGEX.exec(cookie);
	if (!match?.[1]) return undefined;

	// A malformed percent escape must read as "no session", not throw out of the derive.
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return undefined;
	}
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
	let rawProfile: Profile | null = null;
	if (typeof profileId === "string") {
		rawProfile = (await profilesRepository.findByPrimaryIdCached(profileId)) ?? null;
	}
	const ownedProfile: Profile | null = rawProfile?.userId === userId ? rawProfile : null;

	return resolveUnlockedProfile(ownedProfile, typeof unlockValue === "string" ? unlockValue : undefined);
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

/** Whether the request carries a credential the session resolver could act on. */
function hasAuthCredentials(headers: Headers): boolean {
	if (headers.get("authorization") || headers.get("x-api-key")) return true;

	const cookie = headers.get("cookie");
	if (!cookie) return false;

	// Handles both plain HTTP (no prefix) and HTTPS (__Secure- / __Host-) cookie variants
	return AUTH_CREDENTIALS_REGEX.test(cookie);
}

export const sessionResolver = {
	serviceName: "SessionResolver",
	logger: createLogger("SessionResolver"),

	/** The principal of a request that carries no usable credential. */
	anonymous(): ResolvedSession {
		return { user: null, session: null, profile: null };
	},

	/** Whether the request carries a credential at all, so no session lookup is worth starting. */
	hasCredentials(headers: Headers): boolean {
		return hasAuthCredentials(headers);
	},

	/** The principal behind a machine integration key. */
	async fromApiKey(request: Request, apiKey: string, selectedProfileId: unknown, unlockValue: unknown): Promise<ResolvedSession> {
		const principal = await apiKeysService.authenticate(apiKey);
		if (!principal) return sessionResolver.anonymous();

		if (request.method !== "GET" && principal.scope === "read_only") {
			throw new DomainError("forbidden", "This API key is read-only", { code: "api_key.read_only" });
		}

		const [profile, user] = await Promise.all([
			resolveCurrentProfile(request, selectedProfileId, unlockValue, principal.user.id),
			// Full owner record — guards and audit consumers read role/ban state. A blocked owner
			// loses the key at once, the same way a blocked account loses its sessions.
			usersRepository.findById(principal.user.id),
		]);
		if (!user || isBlockedAccount(user, new Date())) return sessionResolver.anonymous();

		return { user, session: null, profile };
	},

	/** The principal behind a better-auth session cookie. */
	async fromSessionCookie(request: Request, selectedProfileId: unknown, unlockValue: unknown): Promise<ResolvedSession> {
		// `disableCookieCache` forces a DB read: the signed session cookie cache
		// would otherwise mask revocation, bans, role changes and password resets
		// for up to 5 minutes (a demoted admin kept `role:"admin"`). The 5 s
		// in-memory cache below keeps that guarantee while avoiding a DB read per
		// HLS segment.
		const sessionToken = extractSessionToken(request.headers);
		const readSession = () => betterAuthApi.getSession({ headers: request.headers, query: { disableCookieCache: true } });
		let session: Awaited<ReturnType<typeof readSession>>;
		if (sessionToken) {
			session = await getOrSetSession(sessionToken, readSession);
		} else {
			session = await readSession();
		}
		if (!session) {
			logger.debug("Missing session", {
				method: request.method,
				url: request.url,
			});

			return sessionResolver.anonymous();
		}

		const user = toUser(session.user);

		return {
			user,
			session: toSession(session.session),
			profile: await resolveCurrentProfile(request, selectedProfileId, unlockValue, user.id),
		};
	},
};
