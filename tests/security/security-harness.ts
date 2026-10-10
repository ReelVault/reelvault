import { beforeAll, beforeEach } from "bun:test";
import { apiRouter } from "@/api/routes";
import { databaseFactory } from "@/database/database";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { invalidateSessionCache } from "@/integrations/better-auth/better-auth.session-cache";
import { clearRateLimitBuckets } from "@/middleware/rate-limit.middleware";
import { stubMethod } from "../helpers/method-stub";

/**
 * Shared harness for the security and crash suites. Requests go through the real
 * `/v1` router (domain errors, validation and guards included); only the
 * better-auth session lookup is replaced, so a cookie selects the role:
 *   `better-auth.session_token=admin-token` → administrator,
 *   `better-auth.session_token=user-token`  → ordinary user,
 *   `better-auth.session_token=other-token` → a second ordinary account (isolation between accounts),
 *   no cookie                               → anonymous.
 */

export type Role = "admin" | "user" | "other";

const SESSION_TOKENS: Record<string, Role> = { "admin-token": "admin", "user-token": "user", "other-token": "other" };

const SESSION_TOKEN_COOKIE = /better-auth\.session_token=([^;]+)/;

export interface RouteEntry {
	method: string;
	/** Route template as registered, e.g. `/v1/libraries/:libraryId`. */
	template: string;
	/** Same route with path parameters filled in. */
	path: string;
}

export function sessionPayload(role: Role) {
	const id = `security-${role}`;
	const now = new Date();

	return {
		user: {
			id,
			name: id,
			email: `${id}@example.test`,
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
			role: role === "admin" ? "admin" : "user",
			banned: false,
		},
		session: {
			id: `session-${id}`,
			userId: id,
			token: `${role}-token`,
			expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
			createdAt: now,
			updatedAt: now,
			ipAddress: "127.0.0.1",
			userAgent: "security-suite",
		},
	};
}

/** Replaces the better-auth session lookup; the caller restores it. */
export function installSessionStub() {
	return stubMethod(betterAuthApi, "getSession", ({ headers }: { headers: Headers }) => {
		const cookie = headers.get("cookie") ?? "";
		const match = SESSION_TOKEN_COOKIE.exec(cookie);
		const role = match?.[1] ? SESSION_TOKENS[match[1]] : undefined;

		return role ? sessionPayload(role) : null;
	});
}

export function listApiRoutes(): RouteEntry[] {
	const routes = (apiRouter as unknown as { routes: Array<{ method: string; path: string }> }).routes;

	return routes
		.map((route) => ({
			method: route.method,
			template: route.path,
			path: route.path.replace(/:[A-Za-z_]+/g, "00000000-0000-4000-8000-000000000000").replace(/\*/g, "probe"),
		}))
		.toSorted((left, right) => `${left.method} ${left.template}`.localeCompare(`${right.method} ${right.template}`));
}

export interface SendOptions {
	role?: Role;
	body?: unknown;
	headers?: Record<string, string>;
	/** Raw body text, sent as is (for malformed JSON cases). */
	rawBody?: string;
}

export async function send(method: string, path: string, options: SendOptions = {}): Promise<Response> {
	const headers: Record<string, string> = { ...options.headers };
	if (options.role) headers.cookie = `better-auth.session_token=${options.role}-token`;
	let body: string | undefined;
	if (options.rawBody !== undefined) {
		body = options.rawBody;
		headers["content-type"] ??= "application/json";
	} else if (options.body !== undefined) {
		body = JSON.stringify(options.body);
		headers["content-type"] ??= "application/json";
	}

	return await apiRouter.handle(new Request(`http://localhost${path}`, { method, headers, body: body ?? null }));
}

/** Runs `send` but gives up after `ms`, so long-lived streams do not hang a suite. */
export async function sendWithin(ms: number, method: string, path: string, options: SendOptions = {}): Promise<Response | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
	});
	try {
		return await Promise.race([send(method, path, options), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Prepares the database schema and a clean session cache before every security test file. */
export function prepareSecuritySuite(): void {
	beforeAll(() => {
		databaseFactory.migrate();
		invalidateSessionCache();
	});
	// Every request in this suite arrives from the same unknown address, so budgets must not carry over.
	beforeEach(() => {
		clearRateLimitBuckets();
		invalidateSessionCache();
	});
}
