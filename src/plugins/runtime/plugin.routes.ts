import type { PluginHttpMethod, PluginHttpRequest, PluginHttpResponse, PluginHttpRoute } from "@sdk/plugin";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { errorMessage, ValidationError } from "@/utils/errors";
import { isRecord } from "@/utils/type.utils";

const PLUGIN_HTTP_METHODS: ReadonlySet<string> = new Set<PluginHttpMethod>(["DELETE", "GET", "PATCH", "POST", "PUT"]);
const PLUGIN_ROUTE_ACCESS_LEVELS: ReadonlySet<string> = new Set(["admin", "user"]);

interface RegisteredPluginRoute {
	route: PluginHttpRoute;
	segments: RouteSegment[];
}

type RouteSegment = { type: "literal"; value: string } | { type: "parameter"; name: string };

const routeParameterNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;
const routePathSegmentPattern = /^[A-Za-z0-9._-]+$/;
const TRIM_SLASHES = /^\/+|\/+$/g;

export interface ResolvedPluginRoute {
	route: PluginHttpRoute;
	params: Readonly<Record<string, string>>;
}

export class PluginRouteValidationError extends Error {}

export class PluginRouteRegistry {
	private readonly routesByPlugin = new Map<string, RegisteredPluginRoute[]>();

	register(pluginId: string, routes: readonly PluginHttpRoute[]): void {
		if (routes.length === 0) return;

		const candidates = routes.map((route) => this.createRegisteredRoute(route));
		const existingRoutes = this.routesByPlugin.get(pluginId) ?? [];

		for (const [index, candidate] of candidates.entries()) {
			const conflictsWithExisting = existingRoutes.some((route) => routesConflict(route, candidate));
			const conflictsWithSibling = candidates.some((route, siblingIndex) => siblingIndex !== index && routesConflict(route, candidate));
			if (conflictsWithExisting || conflictsWithSibling) {
				throw new ValidationError(`Plugin HTTP route conflicts with an existing route: ${candidate.route.method} ${candidate.route.path}`);
			}
		}

		this.routesByPlugin.set(pluginId, candidates);
	}

	unregisterPlugin(pluginId: string): void {
		this.routesByPlugin.delete(pluginId);
	}

	resolve(pluginId: string, method: string, path: string): ResolvedPluginRoute | undefined {
		const normalizedPath = normalizeRequestPath(path);
		for (const route of this.routesByPlugin.get(pluginId) ?? []) {
			if (route.route.method !== method) continue;

			const params = matchRoute(route.segments, normalizedPath);
			if (params) return { route: route.route, params };
		}

		return undefined;
	}

	async dispatch(route: ResolvedPluginRoute, request: PluginHttpRequest): Promise<PluginHttpResponse> {
		assertRequestPart(route.route.params, request.params, "params");
		assertRequestPart(route.route.query, request.query, "query");
		const body = parseRequestBody(route.route.body, request.body);

		const parsedRequest: PluginHttpRequest = {
			params: request.params,
			query: request.query,
			body,
			headers: request.headers,
			user: request.user,
		};

		const response = await route.route.handler(parsedRequest);
		if (!isPluginHttpResponse(response)) throw new ValidationError("Plugin HTTP route must return a response object");

		if (route.route.response && !Value.Check(route.route.response, response.body)) {
			throw new ValidationError("Plugin HTTP response did not match its schema");
		}

		return response;
	}

	private createRegisteredRoute(route: PluginHttpRoute): RegisteredPluginRoute {
		const method = route.method;
		if (!isPluginHttpMethod(method)) throw new ValidationError("Unsupported plugin HTTP method");

		if (route.access !== undefined && !PLUGIN_ROUTE_ACCESS_LEVELS.has(route.access)) {
			throw new ValidationError("Plugin HTTP route access must be 'admin' or 'user'");
		}

		if (typeof route.handler !== "function") throw new ValidationError("Plugin HTTP route handler is required");

		return { route, segments: parseRoutePath(route.path) };
	}
}

function assertRequestPart(schema: TSchema | undefined, value: unknown, name: string): void {
	if (!schema) return;

	if (!Value.Check(schema, value)) {
		throw new PluginRouteValidationError(`Plugin HTTP ${name} did not match its schema`);
	}
}

function parseRequestBody(schema: TSchema | undefined, value: unknown): unknown {
	if (!schema) return value;

	try {
		return Value.Parse(schema, value);
	} catch (error) {
		throw new PluginRouteValidationError(`Plugin HTTP body did not match its schema: ${errorMessage(error)}`);
	}
}

function parseRoutePath(path: string): RouteSegment[] {
	if (!path.startsWith("/")) {
		throw new ValidationError("Plugin HTTP route path must start with '/'");
	}

	if (path === "/") return [];

	if (path.endsWith("/")) {
		throw new ValidationError("Plugin HTTP route path must not end with '/'");
	}

	const parameterNames = new Set<string>();

	return path
		.slice(1)
		.split("/")
		.map((segment) => {
			if (segment.startsWith(":")) {
				const name = segment.slice(1);
				if (!routeParameterNamePattern.test(name) || parameterNames.has(name)) {
					throw new ValidationError(`Plugin HTTP route has an invalid parameter: ${segment}`);
				}

				parameterNames.add(name);

				return { type: "parameter", name };
			}

			if (!routePathSegmentPattern.test(segment)) throw new ValidationError(`Plugin HTTP route has an invalid path segment: ${segment}`);

			return { type: "literal", value: segment };
		});
}

function normalizeRequestPath(path: string): string[] {
	return path.replace(TRIM_SLASHES, "").split("/").filter(Boolean);
}

function matchRoute(segments: readonly RouteSegment[], path: readonly string[]): Record<string, string> | undefined {
	if (segments.length !== path.length) return undefined;

	const params: Record<string, string> = {};
	for (const [index, segment] of segments.entries()) {
		const value = path[index];
		if (!value) return undefined;

		if (segment.type === "literal" && segment.value !== value) return undefined;

		if (segment.type === "parameter") params[segment.name] = value;
	}

	return params;
}

function routesConflict(left: RegisteredPluginRoute, right: RegisteredPluginRoute): boolean {
	if (left.route.method !== right.route.method || left.segments.length !== right.segments.length) return false;

	return left.segments.every((segment, index) => {
		const other = right.segments[index];

		return other !== undefined && (segment.type === "parameter" || other.type === "parameter" || segment.value === other.value);
	});
}

function isPluginHttpMethod(value: string): value is PluginHttpMethod {
	return PLUGIN_HTTP_METHODS.has(value);
}

function isPluginHttpResponse(value: unknown): value is PluginHttpResponse {
	if (!isRecord(value)) return false;

	const status = value.status;
	if (status !== undefined && (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599)) {
		return false;
	}

	const headers = value.headers;
	if (headers !== undefined) {
		if (!isRecord(headers)) return false;

		for (const headerValue of Object.values(headers)) {
			if (typeof headerValue !== "string") return false;
		}
	}

	return true;
}

export const pluginRoutesRegistry = new PluginRouteRegistry();
