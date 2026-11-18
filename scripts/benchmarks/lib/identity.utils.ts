import { identityIndexFor, subnetIp } from "benchkit";
import type { ManagedServer } from "./server.launcher";

/** Rotates the seeded worker session cookies for one simulated client. */
export function workerCookie(server: ManagedServer, workerIndex: number): string {
	return server.workerCookies[workerIndex % server.workerCookies.length] ?? server.cookie;
}

/** The shared identity header payload: an `x-profile-id` is present only when one was resolved. */
function requestHeaders(cookie: string, profileId: string | undefined, forwardedFor: string): Record<string, string> {
	return {
		cookie,
		...(profileId === undefined ? {} : { "x-profile-id": profileId }),
		"x-forwarded-for": forwardedFor,
	};
}

/**
 * Session cookie + per-worker client IP for one simulated identity. The
 * optional `x-profile-id` is required by per-profile routes.
 */
export function authHeaders(server: ManagedServer, workerIndex: number, subnet: number, withProfile = false): Record<string, string> {
	return requestHeaders(
		workerCookie(server, workerIndex),
		withProfile ? server.profileIdFor(workerIndex) : undefined,
		subnetIp(subnet, workerIndex),
	);
}

/** Admin session cookie (+ profile) with the caller's suite-specific client IP. */
export function adminHeaders(server: ManagedServer, forwardedFor: string, withProfile = true): Record<string, string> {
	return requestHeaders(server.cookie, withProfile ? server.adminProfileId : undefined, forwardedFor);
}

/** Cookie+profile pair of the rotating identity scheme, bound to one managed server. */
export interface RotatingIdentity {
	cookieFor(workerIndex: number, requestIndex: number): string;
	profileIdFor(workerIndex: number, requestIndex: number): string;
}

export function rotatingIdentity(server: ManagedServer): RotatingIdentity {
	const identityFor = (workerIndex: number, requestIndex: number): number =>
		identityIndexFor(workerIndex, requestIndex, server.workerCookies.length);

	return {
		cookieFor: (workerIndex, requestIndex) => workerCookie(server, identityFor(workerIndex, requestIndex)),
		profileIdFor: (workerIndex, requestIndex) => server.profileIdFor(identityFor(workerIndex, requestIndex)),
	};
}

/** Identity headers for a context exposing the rotating cookie/profile pair. */
export function contextHeaders(
	context: RotatingIdentity,
	subnet: number,
	workerIndex: number,
	requestIndex: number,
	withProfile = false,
): Record<string, string> {
	return requestHeaders(
		context.cookieFor(workerIndex, requestIndex),
		withProfile ? context.profileIdFor(workerIndex, requestIndex) : undefined,
		subnetIp(subnet, workerIndex),
	);
}
