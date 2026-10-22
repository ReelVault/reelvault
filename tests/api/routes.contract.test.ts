import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiRouter } from "@/api/routes/api.routes";

/**
 * The route table as a contract: every path resolves to one handler, and every endpoint the
 * published SDK client calls exists. The SDK is read from its compiled client in node_modules — the
 * version the apps ship with.
 */

interface Route {
	method: string;
	path: string;
}

const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** `this._get("/path", …)` in the compiled SDK resources; a template literal's `${…}` becomes a parameter. */
const SDK_CALL_REGEX = /this\._(get|post|put|patch|delete)\s*\(\s*([`'"])(.*?)\2/g;
const TEMPLATE_PARAM_REGEX = /\$\{[^}]+\}/g;

function isRoute(value: unknown): value is Route {
	if (typeof value !== "object" || value === null || !("method" in value) || !("path" in value)) return false;

	return typeof value.method === "string" && HTTP_METHODS.has(value.method) && typeof value.path === "string";
}

const routes: Route[] = Object.values(apiRouter.routes).filter((route) => isRoute(route));

function segments(path: string): string[] {
	return path.split("/").filter(Boolean);
}

/** The same route shape, a parameter on either side matching any segment. */
function sameShape(left: string, right: string): boolean {
	const leftSegments = segments(left);
	const rightSegments = segments(right);
	if (leftSegments.length !== rightSegments.length) return false;

	return leftSegments.every((segment, index) => {
		const other = rightSegments[index] ?? "";

		return segment === other || segment.startsWith(":") || other.startsWith(":");
	});
}

/**
 * Two paths where only one can ever be reached: at the first segment where they differ, both hold a
 * parameter. A static segment against a parameter is fine — the router prefers the static one.
 */
function shadows(left: string, right: string): boolean {
	const leftSegments = segments(left);
	const rightSegments = segments(right);
	if (leftSegments.length !== rightSegments.length) return false;

	for (const [index, segment] of leftSegments.entries()) {
		const other = rightSegments[index] ?? "";
		if (segment !== other) return segment.startsWith(":") && other.startsWith(":");
	}

	return false;
}

function sdkEndpoints(): Route[] {
	const resources = join(dirname(Bun.resolveSync("@reelvault/sdk/client", import.meta.dir)), "resources");
	const endpoints: Route[] = [];
	for (const file of readdirSync(resources).filter((name) => name.endsWith(".mjs"))) {
		for (const match of readFileSync(join(resources, file), "utf8").matchAll(SDK_CALL_REGEX)) {
			const path = (match[3] ?? "").replaceAll(TEMPLATE_PARAM_REGEX, ":param");
			endpoints.push({ method: (match[1] ?? "").toUpperCase(), path: `/v1${path.startsWith("/") ? "" : "/"}${path}` });
		}
	}

	return endpoints;
}

describe("route table", () => {
	test("has no two routes of one method where a parameter hides the other", () => {
		const shadowed: string[] = [];
		for (const [index, route] of routes.entries()) {
			for (const other of routes.slice(index + 1)) {
				if (route.method === other.method && shadows(route.path, other.path))
					shadowed.push(`${route.method} ${route.path} vs ${other.path}`);
			}
		}

		expect(shadowed).toEqual([]);
	});

	test("serves every endpoint the published SDK client calls", () => {
		const endpoints = sdkEndpoints();
		const missing = endpoints
			.filter((endpoint) => !routes.some((route) => route.method === endpoint.method && sameShape(route.path, endpoint.path)))
			.map((endpoint) => `${endpoint.method} ${endpoint.path}`);

		// @reelvault/sdk 1.3.0 calls 308 endpoints; a scan that found none would pass vacuously.
		expect(endpoints.length).toBe(308);
		expect(missing).toEqual([]);
	});
});
