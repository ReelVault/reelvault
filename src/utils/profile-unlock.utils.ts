import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless proof that a PIN-protected profile was unlocked by this client.
 *
 * The account session alone must not grant access to a PIN-protected profile —
 * the profile PIN is a lock *within* the account. A signed cookie (HMAC over
 * `profileId.expiry.pinFingerprint`) is set on a successful switch/quick-connect
 * and verified by the auth middleware, so `x-profile-id`/`current_profile_id`
 * cannot bypass the PIN without the token.
 *
 * Binding the fingerprint of the stored PIN hash means changing (or adding) a PIN
 * invalidates every previously issued unlock token.
 */
export const PROFILE_UNLOCK_COOKIE = "profile_unlock";

const TOKEN_SEPARATOR = ".";
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

/** Stable, non-reversible marker for a stored PIN hash. Empty when there is no PIN. */
export function profilePinFingerprint(pin: string | null | undefined): string {
	if (!pin) return "";

	return createHash("sha256").update(pin).digest("base64url").slice(0, 16);
}

function signatureFor(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Whether a profile may be selected with the given signed unlock token.
 * Profiles without a PIN are always unlocked; a PIN-protected one requires a
 * valid token bound to the current PIN fingerprint.
 */
export function isProfileUnlocked(
	profile: { id: string; pin: string | null | undefined },
	unlockToken: string | undefined,
	secret: string,
): boolean {
	if (!profile.pin) return true;

	const unlock = verifyProfileUnlock(unlockToken, secret);

	return unlock?.profileId === profile.id && unlock.pinFingerprint === profilePinFingerprint(profile.pin);
}

export function signProfileUnlock(profileId: string, secret: string, pinFingerprint = "", ttlSeconds = DEFAULT_TTL_SECONDS): string {
	const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
	const payload = `${profileId}${TOKEN_SEPARATOR}${expiresAt}${TOKEN_SEPARATOR}${pinFingerprint}`;

	return `${payload}${TOKEN_SEPARATOR}${signatureFor(payload, secret)}`;
}

export function verifyProfileUnlock(
	token: string | undefined,
	secret: string,
): { profileId: string; expiresAt: number; pinFingerprint: string } | null {
	if (!token) return null;

	const parts = token.split(TOKEN_SEPARATOR);
	if (parts.length !== 4) return null;

	const [profileId, expiresText, pinFingerprint, signature] = parts;
	if (!(profileId && expiresText && signature)) return null;

	const expiresAt = Number.parseInt(expiresText, 10);
	if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return null;

	const fingerprint = pinFingerprint ?? "";
	const expected = Buffer.from(signatureFor(`${profileId}${TOKEN_SEPARATOR}${expiresText}${TOKEN_SEPARATOR}${fingerprint}`, secret));
	const actual = Buffer.from(signature);
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

	return { profileId, expiresAt, pinFingerprint: fingerprint };
}
