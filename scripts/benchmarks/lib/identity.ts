import type { ManagedServer } from "./server";

/** Rotates the seeded worker session cookies for one simulated client. */
export function workerCookie(server: ManagedServer, workerIndex: number): string {
	return server.workerCookies[workerIndex % server.workerCookies.length] ?? server.cookie;
}

/**
 * Per-worker client IP inside the suite-reserved 10.<subnet>.x.x block — every
 * suite claims its own subnet so per-IP rate limiting stays scoped to the suite.
 */
export function subnetIp(subnet: number, workerIndex: number): string {
	return `10.${subnet}.${Math.floor(workerIndex / 250) % 250}.${(workerIndex % 250) + 1}`;
}

/**
 * Session cookie + per-worker client IP for one simulated identity. The
 * optional `x-profile-id` is required by per-profile routes.
 */
export function authHeaders(server: ManagedServer, workerIndex: number, subnet: number, withProfile = false): Record<string, string> {
	return {
		cookie: workerCookie(server, workerIndex),
		...(withProfile ? { "x-profile-id": server.profileIdFor(workerIndex) } : {}),
		"x-forwarded-for": subnetIp(subnet, workerIndex),
	};
}

/** Admin session cookie (+ profile) with the caller's suite-specific client IP. */
export function adminHeaders(server: ManagedServer, forwardedFor: string, withProfile = true): Record<string, string> {
	return {
		cookie: server.cookie,
		...(withProfile ? { "x-profile-id": server.adminProfileId } : {}),
		"x-forwarded-for": forwardedFor,
	};
}
