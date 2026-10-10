import { afterAll, beforeEach, expect, test } from "bun:test";
import { invalidateSessionCache } from "@/integrations/better-auth/better-auth.session-cache";
import { installSessionStub, listApiRoutes, prepareSecuritySuite, type RouteEntry, sendWithin } from "./security-harness";

/**
 * Authorization matrix over every registered `/v1` route. The route table is read
 * from the router itself, so a route added later is covered without touching this
 * file. Anonymous and ordinary-user requests must never succeed on protected routes
 * and never crash the server; the public list below is the only exception and each
 * entry says why it is public.
 */

prepareSecuritySuite();

const sessionStub = installSessionStub();
afterAll(() => sessionStub.restore());
beforeEach(() => invalidateSessionCache());

const routeKey = (route: RouteEntry) => `${route.method} ${route.template}`;

/** Routes that answer without a session on purpose, with the only statuses they may return. */
const PUBLIC_ROUTES: Record<string, { statuses: number[]; reason: string }> = {
	"GET /v1/capabilities/": { statuses: [200], reason: "server capabilities shown on the sign-in and setup screens" },
	"GET /v1/health/live": { statuses: [200], reason: "liveness probe" },
	"GET /v1/health/": { statuses: [200, 503], reason: "health summary; 503 while a subsystem is down" },
	"GET /v1/health/ready": { statuses: [200, 503], reason: "readiness probe" },
	"GET /v1/setup/status": { statuses: [200], reason: "first-run wizard asks whether setup is required" },
	"POST /v1/auth/logout": { statuses: [200], reason: "idempotent sign-out, clears cookies without a session" },
	"POST /v1/auth/quick-connect/initiate": { statuses: [200], reason: "device-code flow starts before sign-in" },
	"GET /v1/images/:imageId": { statuses: [200, 404], reason: "poster and backdrop files are public by design (isImageAssetPath)" },
	"GET /v1/plugins/ui/*": { statuses: [200, 404], reason: "plugin UI bundles are static and secret-free (isPluginUiPath)" },
};

/** What a rejected anonymous or non-admin request may return. Anything else is a finding. */
const REJECTED_STATUSES = [400, 401, 403, 404, 405, 413, 422, 429];

/** Long-lived responses (event streams, segment downloads) can legitimately outlast a probe. */
const STREAMING_PATH = /\/(events|stream|segments?|hls)(\/|$)/;

function hasBody(method: string): boolean {
	return !["GET", "HEAD", "OPTIONS"].includes(method);
}

async function snippet(response: Response): Promise<string> {
	return (await response.text()).slice(0, 160).replace(/\s+/g, " ");
}

test("every route rejects anonymous requests unless it is public on purpose", async () => {
	const findings: string[] = [];

	for (const route of listApiRoutes()) {
		const response = await sendWithin(5000, route.method, route.path, hasBody(route.method) ? { body: {} } : {});
		const key = routeKey(route);
		if (response === "timeout") {
			findings.push(`${key} anonymous: timed out`);
			continue;
		}
		const allowed = PUBLIC_ROUTES[key]?.statuses ?? REJECTED_STATUSES;
		if (!allowed.includes(response.status)) findings.push(`${key} anonymous -> ${response.status} ${await snippet(response)}`);
	}

	expect(findings).toEqual([]);
});

test("administrator routes reject an ordinary signed-in user", async () => {
	const findings: string[] = [];
	const adminRoutes = listApiRoutes().filter((route) => route.template.startsWith("/v1/admin/"));
	expect(adminRoutes.length).toBeGreaterThan(50);

	for (const route of adminRoutes) {
		const response = await sendWithin(5000, route.method, route.path, { role: "user", ...(hasBody(route.method) ? { body: {} } : {}) });
		if (response === "timeout") {
			findings.push(`${routeKey(route)} as user: timed out`);
			continue;
		}
		// Validation runs before the admin guard, so a body-validation 400 is also a refusal; success never is.
		const refused = response.status === 403 || response.status === 400 || response.status === 429;
		if (!refused) findings.push(`${routeKey(route)} as user -> ${response.status} ${await snippet(response)}`);
	}

	expect(findings).toEqual([]);
});

test("ordinary read routes never crash for a signed-in user", async () => {
	const findings: string[] = [];
	const readRoutes = listApiRoutes().filter((route) => route.method === "GET" && !route.template.startsWith("/v1/admin/"));
	expect(readRoutes.length).toBeGreaterThan(30);

	for (const route of readRoutes) {
		const response = await sendWithin(STREAMING_PATH.test(route.path) ? 1500 : 5000, route.method, route.path, { role: "user" });
		if (response === "timeout") {
			if (!STREAMING_PATH.test(route.path)) findings.push(`${routeKey(route)} as user: timed out`);
			continue;
		}
		// The health routes answer 503 by design while a subsystem is down; that is a report, not a crash.
		const reportedHealth = route.template.startsWith("/v1/health") && response.status === 503;
		if (response.status >= 500 && !reportedHealth)
			findings.push(`${routeKey(route)} as user -> ${response.status} ${await snippet(response)}`);
	}

	expect(findings).toEqual([]);
});
