// oxlint-disable no-console
import fs from "node:fs";
import path from "node:path";
import { apiRouter } from "../src/api/routes/index";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const isHttpMethod = (value: string): value is HttpMethod => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(value);

interface RouteDef {
	method: HttpMethod;
	path: string;
}

interface SdkEndpoint {
	file: string;
	method: HttpMethod;
	raw: string;
	normalized: string;
}

const toSegments = (p: string): readonly string[] => p.split("/").filter(Boolean);

/** Runtime guard for Elysia's loosely-typed route registry. */
const isRouteDef = (value: unknown): value is RouteDef => {
	if (typeof value !== "object" || value === null) return false;

	if (!("method" in value && "path" in value)) return false;

	const { method, path: routePath } = value;

	return typeof method === "string" && isHttpMethod(method) && typeof routePath === "string";
};

/**
 * True if two path-segment lists represent the same route shape,
 * treating any `:param`-style segment on either side as a wildcard.
 */
const segmentsMatch = (a: readonly string[], b: readonly string[]): boolean => {
	if (a.length !== b.length) return false;

	return a.every((seg, i) => {
		const other = b[i];
		if (other === undefined) return false;

		const isParamA = seg.startsWith(":");
		const isParamB = other.startsWith(":") || other === ":param";

		return isParamA || isParamB || seg === other;
	});
};

const findDuplicates = (routes: readonly RouteDef[]): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>();
	for (const r of routes) {
		const key = `${r.method} ${r.path}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	return new Map([...counts].filter(([, count]) => count > 1));
};

const findShadowedRoutes = (routes: readonly RouteDef[]): readonly string[] => {
	const byMethod = new Map<HttpMethod, string[]>();
	for (const r of routes) {
		byMethod.set(r.method, [...(byMethod.get(r.method) ?? []), r.path]);
	}

	const collisions: string[] = [];
	for (const [method, paths] of byMethod) {
		for (let i = 0; i < paths.length; i++) {
			for (let j = i + 1; j < paths.length; j++) {
				const pathA = paths[i];
				const pathB = paths[j];
				if (pathA === undefined || pathB === undefined) continue;

				if (pathA === pathB) continue; // exact dupes handled separately

				const segA = toSegments(pathA);
				const segB = toSegments(pathB);
				if (segmentsMatch(segA, segB)) {
					collisions.push(`${method}: "${pathA}" vs "${pathB}"`);
				}
			}
		}
	}

	return collisions;
};

const scanSdkEndpoints = (sdkDir: string): readonly SdkEndpoint[] => {
	const callRegex = /this\._(get|post|put|patch|delete)\s*(?:<[^>]+>)?\s*\(\s*([`'"])(.*?)\2/g;
	const endpoints: SdkEndpoint[] = [];

	for (const file of fs.readdirSync(sdkDir).filter((f) => f.endsWith(".ts"))) {
		const content = fs.readFileSync(path.join(sdkDir, file), "utf-8");
		for (const match of content.matchAll(callRegex)) {
			const methodName = match[1];
			const raw = match[3];

			if (methodName === undefined || raw === undefined) continue;

			const upper = methodName.toUpperCase();
			if (!isHttpMethod(upper)) continue;

			const method = upper;
			const withParams = raw.replace(/\$\{[^}]+\}/g, ":param");
			const normalized = `/v1${withParams.startsWith("/") ? withParams : `/${withParams}`}`;

			endpoints.push({ file, method, raw, normalized });
		}
	}

	return endpoints;
};

const findUnmatchedRoutes = (routes: readonly RouteDef[], sdkEndpoints: readonly SdkEndpoint[]): readonly string[] =>
	routes
		.filter((r) => !sdkEndpoints.some((sdk) => sdk.method === r.method && segmentsMatch(toSegments(r.path), toSegments(sdk.normalized))))
		.map((r) => `${r.method} ${r.path}`);

const findUnmatchedSdkCalls = (routes: readonly RouteDef[], sdkEndpoints: readonly SdkEndpoint[]): readonly string[] =>
	sdkEndpoints
		.filter((sdk) => !routes.some((r) => r.method === sdk.method && segmentsMatch(toSegments(r.path), toSegments(sdk.normalized))))
		.map((sdk) => `[${sdk.file}] ${sdk.method} ${sdk.raw} -> ${sdk.normalized}`);

const printSection = (title: string, lines: readonly string[]): void => {
	console.log(`\n${title} (${lines.length}):`);
	lines.forEach((line) => {
		console.log(" ", line);
	});
};

const main = (): void => {
	const routeValues: unknown[] = Object.values(apiRouter.routes);
	const routes: readonly RouteDef[] = routeValues.filter((route) => isRouteDef(route));
	console.log("=== ALL API ROUTES ===");
	console.log("Total routes in apiRouter:", routes.length);

	const duplicates = findDuplicates(routes);
	console.log("\nExact duplicates count:", duplicates.size);
	for (const [key, count] of duplicates) {
		console.log("  DUPLICATE:", key, "count:", count);
	}

	console.log("\n=== CHECKING ROUTE SHADOWING / OVERLAPS ===");
	findShadowedRoutes(routes).forEach((line) => {
		console.log(`[SHADOWING/OVERLAP] ${line}`);
	});

	const sdkDir = path.resolve(__dirname, "../sdk/client/resources");
	const sdkEndpoints = scanSdkEndpoints(sdkDir);
	console.log("\nTotal SDK endpoints called:", sdkEndpoints.length);

	printSection("\nRoutes NOT matched by any SDK client method", findUnmatchedRoutes(routes, sdkEndpoints));
	printSection("\nSDK calls NOT matched by any server route", findUnmatchedSdkCalls(routes, sdkEndpoints));

	process.exit(0);
};

main();
