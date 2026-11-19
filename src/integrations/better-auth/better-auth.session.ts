import { makeSignature } from "better-auth/crypto";
import { AUTH_SESSION_LIFETIME_SECONDS } from "@/config/definitions/system.definitions";
import { env } from "@/config/env.config";
import { PROFILE_UNLOCK_COOKIE, PROFILE_UNLOCK_TTL_SECONDS, profilePinFingerprint, signProfileUnlock } from "@/utils/profile-unlock.utils";
import { auth } from "./better-auth.config";

export interface IssuedSession {
	/** `<sessionToken>.<signature>` as expected by the session cookie. */
	signedToken: string;
	/** `Set-Cookie` header values (session cookie + optional current profile). */
	cookies: string[];
}

interface CookieOptions {
	path: string;
	httpOnly: boolean;
	secure: boolean;
	sameSite: string;
	maxAge: number;
}

/** Serializes one `Set-Cookie` header value. */
function serializeCookie(name: string, value: string, options: CookieOptions): string {
	return [
		`${name}=${value}`,
		`Path=${options.path}`,
		options.httpOnly ? "HttpOnly" : "",
		`SameSite=${options.sameSite}`,
		`Max-Age=${options.maxAge}`,
		options.secure ? "Secure" : "",
	]
		.filter(Boolean)
		.join("; ");
}

/**
 * Issues a better-auth session and materializes its cookies. Kept in the
 * integration layer so application use cases never touch better-auth internals.
 */
export async function issueSession(userId: string, profileId?: string | null, profilePin?: string | null): Promise<IssuedSession> {
	const ctx = await auth.$context;
	const session = await ctx.internalAdapter.createSession(userId);
	const signature = await makeSignature(session.token, ctx.secret);
	const signedToken = `${session.token}.${signature}`;

	const attrs = ctx.authCookies.sessionToken.attributes;
	const maxAge = attrs.maxAge ?? AUTH_SESSION_LIFETIME_SECONDS;
	const cookies: string[] = [
		serializeCookie(ctx.authCookies.sessionToken.name, signedToken, {
			path: attrs.path ?? "/",
			httpOnly: Boolean(attrs.httpOnly),
			secure: Boolean(attrs.secure),
			sameSite: attrs.sameSite ?? "lax",
			maxAge,
		}),
	];
	if (profileId) {
		const cookieAttrs = { path: "/", httpOnly: Boolean(attrs.httpOnly), secure: Boolean(attrs.secure), sameSite: "Lax", maxAge };
		cookies.push(serializeCookie("current_profile_id", profileId, cookieAttrs));
		// Quick-connect is authorized from an already-authenticated device, so the
		// paired device starts with the profile unlocked (same as a manual switch).
		const unlock = encodeURIComponent(signProfileUnlock(profileId, env.BETTER_AUTH_SECRET, profilePinFingerprint(profilePin)));
		cookies.push(serializeCookie(PROFILE_UNLOCK_COOKIE, unlock, { ...cookieAttrs, maxAge: PROFILE_UNLOCK_TTL_SECONDS }));
	}

	return { signedToken, cookies };
}
