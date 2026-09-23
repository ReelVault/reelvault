import { makeSignature } from "better-auth/crypto";
import { env } from "@/env";
import { PROFILE_UNLOCK_COOKIE, profilePinFingerprint, signProfileUnlock } from "@/utils/profile-unlock.utils";
import { auth } from "./better-auth.config";

export interface IssuedSession {
	/** `<sessionToken>.<signature>` as expected by the session cookie. */
	signedToken: string;
	/** `Set-Cookie` header values (session cookie + optional current profile). */
	cookies: string[];
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

	const cookieName = ctx.authCookies.sessionToken.name;
	const attrs = ctx.authCookies.sessionToken.attributes;
	const parts = [
		`${cookieName}=${signedToken}`,
		`Path=${attrs.path ?? "/"}`,
		attrs.httpOnly ? "HttpOnly" : "",
		`SameSite=${attrs.sameSite ?? "lax"}`,
		`Max-Age=${attrs.maxAge ?? 604800}`,
		attrs.secure ? "Secure" : "",
	].filter(Boolean);

	const cookies: string[] = [parts.join("; ")];
	if (profileId) {
		const httpOnly = attrs.httpOnly ? "HttpOnly; " : "";
		const secure = attrs.secure ? "Secure; " : "";
		cookies.push(`current_profile_id=${profileId}; Path=/; ${httpOnly}${secure}SameSite=Lax; Max-Age=${attrs.maxAge ?? 604800}`);
		// Quick-connect is authorized from an already-authenticated device, so the
		// paired device starts with the profile unlocked (same as a manual switch).
		cookies.push(
			`${PROFILE_UNLOCK_COOKIE}=${encodeURIComponent(signProfileUnlock(profileId, env.BETTER_AUTH_SECRET, profilePinFingerprint(profilePin)))}; Path=/; ${httpOnly}${secure}SameSite=Lax; Max-Age=43200`,
		);
	}

	return { signedToken, cookies };
}
