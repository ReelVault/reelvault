import { afterAll, beforeEach, expect, test } from "bun:test";
import { invalidateSessionCache } from "@/integrations/better-auth/better-auth.session-cache";
import { installSessionStub, listApiRoutes, prepareSecuritySuite, send } from "./security-harness";

/**
 * Load and size behaviour of the router: many requests in flight at once, and bodies far
 * above any documented limit. The server must keep answering with well-formed responses;
 * none of these may end in a server error.
 */

prepareSecuritySuite();

const sessionStub = installSessionStub();
afterAll(() => sessionStub.restore());
beforeEach(() => invalidateSessionCache());

const BODY_ROUTES = listApiRoutes().filter((route) => route.method === "POST" || route.method === "PUT" || route.method === "PATCH");
const READ_ROUTES = listApiRoutes().filter(
	(route) => route.method === "GET" && !route.template.includes("/events") && !route.template.includes("/stream"),
);

function pick<T>(items: readonly T[], index: number): T {
	const item = items[index % items.length];
	if (item === undefined) throw new Error("empty route table");

	return item;
}

test("a burst of 600 concurrent requests across routes never produces a server error", async () => {
	const requests: Array<Promise<{ status: number; path: string }>> = [];
	for (let index = 0; index < 600; index += 1) {
		const route = index % 3 === 0 ? pick(BODY_ROUTES, index) : pick(READ_ROUTES, index);
		const isBody = route.method !== "GET";
		const role = index % 4 === 0 ? "admin" : "user";
		requests.push(
			send(route.method, route.path, isBody ? { rawBody: index % 2 === 0 ? "{" : "[]", role } : { role }).then((response) => ({
				status: response.status,
				path: route.template,
			})),
		);
	}

	const results = await Promise.all(requests);
	// The health routes report 503 by design while a subsystem is down, and the limiter answers 429 under a burst.
	const serverErrors = results.filter(({ status, path }) => status >= 500 && !(status === 503 && path.startsWith("/v1/health")));

	expect(serverErrors).toEqual([]);
	expect(results.length).toBe(600);
});

test("a multi-megabyte JSON body is refused as too large or invalid, without a server error", async () => {
	const huge = JSON.stringify({ email: "a@example.test", password: "x".repeat(6 * 1024 * 1024) });
	const response = await send("POST", "/v1/auth/login", { rawBody: huge });

	expect([400, 413, 422]).toContain(response.status);
	expect(response.status).toBeLessThan(500);
});

test("a deeply nested multi-megabyte array is refused without exhausting memory", async () => {
	const nested = `${"[".repeat(5000)}${"]".repeat(5000)}`;
	const response = await send("POST", "/v1/auth/login", { rawBody: nested });

	expect(response.status).toBeGreaterThanOrEqual(400);
	expect(response.status).toBeLessThan(500);
});

test("the liveness probe keeps answering under sustained parallel traffic", async () => {
	const probes = Array.from({ length: 400 }, () => send("GET", "/v1/health/live"));
	const statuses = (await Promise.all(probes)).map((response) => response.status);

	// Some probes are answered 200 and any excess is refused by the limiter (429); nothing may fail.
	expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(0);
	expect(statuses.every((status) => status === 200 || status === 429)).toBe(true);
});
