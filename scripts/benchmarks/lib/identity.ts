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
