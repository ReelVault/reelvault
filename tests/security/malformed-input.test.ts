import { afterAll, beforeEach, expect, test } from "bun:test";
import { invalidateSessionCache } from "@/integrations/better-auth/better-auth.session-cache";
import { installSessionStub, listApiRoutes, prepareSecuritySuite, type RouteEntry, sendWithin } from "./security-harness";

/**
 * Crash suite: every route receives a series of malformed bodies and query strings.
 * A malformed request may be refused in any way the API documents, but it must
 * never crash the handler (500) and an anonymous caller must never succeed. Error
 * responses must use the JSON error envelope (`statusCode` and `code`).
 */

prepareSecuritySuite();

const sessionStub = installSessionStub();
afterAll(() => sessionStub.restore());
beforeEach(() => invalidateSessionCache());

const ANONYMOUS_REFUSALS = new Set([400, 401, 403, 404, 405, 413, 422, 429]);

const MALFORMED_BODIES: Array<{ name: string; rawBody: string }> = [
	{ name: "truncated JSON", rawBody: '{"name":' },
	{ name: "JSON null", rawBody: "null" },
	{ name: "JSON array", rawBody: "[]" },
	{ name: "JSON string", rawBody: '"text"' },
	{ name: "JSON number", rawBody: "42" },
	{ name: "nested arrays", rawBody: "[[[[[[[[]]]]]]]]" },
	{ name: "prototype keys", rawBody: '{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}}}' },
	{ name: "deep object", rawBody: `${'{"a":'.repeat(200)}1${"}".repeat(200)}` },
	{ name: "numeric overflow", rawBody: '{"limit":1e400,"page":-0,"ids":[1e999]}' },
	{ name: "control characters", rawBody: '{"name":"a\\u0000b\\u0007\\u001f"}' },
	{ name: "lone surrogate", rawBody: '{"name":"\\uD800"}' },
	{ name: "empty body", rawBody: "" },
	{ name: "binary garbage", rawBody: "\u0000\u0001\u0002 not json �" },
	{ name: "wrong types everywhere", rawBody: '{"id":[],"name":{},"limit":"ten","enabled":"yes","ids":"x","page":null}' },
	{ name: "oversized array", rawBody: JSON.stringify({ ids: Array.from({ length: 3000 }, (_, index) => `id-${index}`) }) },
];

const QUERY_STRINGS = [
	"?limit=-1",
	"?limit=1e400",
	"?page=0&limit=100000",
	"?cursor=%00%ff",
	"?sort=__proto__",
	`?q=${"x".repeat(4000)}`,
	"?ids=1&ids=2&ids=3",
	"?enabled=maybe",
];

function isJsonError(response: Response, body: string): boolean {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) return false;
	try {
		const parsed = JSON.parse(body) as { statusCode?: unknown; code?: unknown };
		return parsed.statusCode === response.status && typeof parsed.code === "string";
	} catch {
		return false;
	}
}

function bodyRoutes(): RouteEntry[] {
	return listApiRoutes().filter((route) => !["GET", "HEAD", "OPTIONS"].includes(route.method));
}

test("no route crashes on a malformed body, and anonymous callers never succeed", async () => {
	const findings: string[] = [];

	for (const route of bodyRoutes()) {
		for (const malformed of MALFORMED_BODIES) {
			const response = await sendWithin(5000, route.method, route.path, { rawBody: malformed.rawBody });
			if (response === "timeout") {
				findings.push(`${route.method} ${route.template} [${malformed.name}] anonymous: timed out`);
				continue;
			}
			const text = await response.text();
			if (!ANONYMOUS_REFUSALS.has(response.status)) {
				findings.push(`${route.method} ${route.template} [${malformed.name}] anonymous -> ${response.status} ${text.slice(0, 140)}`);
			} else if (!isJsonError(response, text) && response.status !== 405) {
				findings.push(`${route.method} ${route.template} [${malformed.name}] anonymous error without JSON envelope -> ${response.status}`);
			}
		}
	}

	expect(findings).toEqual([]);
});

test("administrator routes refuse malformed bodies from an ordinary user without a server error", async () => {
	const findings: string[] = [];
	const adminBodyRoutes = bodyRoutes().filter((route) => route.template.startsWith("/v1/admin/"));

	for (const route of adminBodyRoutes) {
		for (const malformed of MALFORMED_BODIES) {
			const response = await sendWithin(5000, route.method, route.path, { role: "user", rawBody: malformed.rawBody });
			if (response === "timeout") {
				findings.push(`${route.method} ${route.template} [${malformed.name}] as user: timed out`);
				continue;
			}
			// Validation (400) runs before the administrator guard (403); both are refusals, anything else is a finding.
			if (![400, 403, 413, 429].includes(response.status)) {
				findings.push(`${route.method} ${route.template} [${malformed.name}] as user -> ${response.status}`);
			}
		}
	}

	expect(findings).toEqual([]);
});

test("query strings with hostile values never crash a read route", async () => {
	const findings: string[] = [];
	const readRoutes = listApiRoutes().filter(
		(route) => route.method === "GET" && !route.template.includes("/events") && !route.template.includes("/stream"),
	);

	for (const route of readRoutes) {
		for (const query of QUERY_STRINGS) {
			const response = await sendWithin(5000, route.method, `${route.path}${query}`, { role: "user" });
			if (response === "timeout") {
				findings.push(`GET ${route.template}${query} as user: timed out`);
				continue;
			}
			const reportedHealth = route.template.startsWith("/v1/health") && response.status === 503;
			if (response.status >= 500 && !reportedHealth) {
				findings.push(`GET ${route.template}${query} as user -> ${response.status}`);
			}
		}
	}

	expect(findings).toEqual([]);
});
