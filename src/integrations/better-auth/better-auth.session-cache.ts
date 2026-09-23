import { MemoryCache } from "@/utils/memory-cache";
import type { auth } from "./better-auth.config";

/**
 * Very short session-verification cache. `auth.api.getSession` runs two
 * synchronous SQLite reads and the auth derive is global — every HLS segment and
 * catalog request paid it. 5 s bounds revocation lag to a fraction of the old
 * 5-minute cookie cache while removing the per-segment DB hit.
 *
 * Lives in the better-auth integration layer (not middleware) so application
 * services can invalidate it through the adapter without importing Elysia.
 */
const SESSION_CACHE_TTL_MS = 5_000;

export type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>;

const sessionCache = new MemoryCache<SessionResult>({ ttlMs: SESSION_CACHE_TTL_MS, maxSize: 2000, name: "auth-session" });

export function getOrSetSession(token: string, loader: () => Promise<SessionResult>): Promise<SessionResult> {
	return sessionCache.getOrSet(token, loader);
}

/** Drops every cached session verification. Called on auth mutations (and by tests). */
export function invalidateSessionCache(): void {
	sessionCache.clear();
}
