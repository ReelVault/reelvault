import { PluginRuntimeStatusSchema } from "@reelvault/sdk/common";
import Elysia, { type HTTPHeaders, type StatusMap, t } from "elysia";
import { authMiddleware } from "@/api/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/api/middleware/rate-limit.middleware";
import { commonModel } from "@/api/schemas/common.schema";
import { PluginIdParams } from "@/api/schemas/route-params.schema";
import { MINUTE } from "@/config/server/server.constants";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { pluginRouteDispatchService } from "@/services/plugins/plugin-route-dispatch.service";
import { DomainError } from "@/utils/domain.errors";

/** Hop-by-hop / security-sensitive headers a plugin must not set on the host response. */
const FORBIDDEN_PLUGIN_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
	"set-cookie",
	"set-cookie2",
	"content-length",
	"content-encoding",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"upgrade",
	"te",
	"trailer",
	"proxy-authenticate",
	"proxy-authorization",
	"host",
]);

/** The request context Elysia hands a plugin route handler, typed as far as the dispatch reads it. */
interface PluginRouteContext {
	params: { pluginId: string; "*"?: string };
	request: Request;
	set: { status?: number | keyof StatusMap; headers: HTTPHeaders };
	user: { id?: string; role?: string } | null | undefined;
	profile?: { id: string } | null | undefined;
	body?: unknown;
}

// Plugin-owned routes can do arbitrary work; bound them per profile so a
// single account cannot hammer any plugin endpoint. The global limiter
// only exempts playback segments, so this is additive.
const rootRouteOptions = {
	rateLimit: { name: "plugin-route", max: 300, windowMs: MINUTE, perParam: "pluginId" },
	params: PluginIdParams,
	// Plugin-owned payload: the plugin's declared response schema validates it.
	response: t.Unknown(),
	detail: {
		description: "Dispatches a root declared plugin route.",
	},
};

const nestedRouteOptions = {
	rateLimit: { name: "plugin-route", max: 300, windowMs: MINUTE, perParam: "pluginId" },
	// No params schema here: Elysia's exactMirror cannot compile a TypeBox
	// object that owns the "*" wildcard key, which silently kills this route.
	// pluginId is re-validated inside the dispatch instead.
	// Plugin-owned payload: the plugin's declared response schema validates it.
	response: t.Unknown(),
	detail: {
		description: "Dispatches a declared plugin route through the core authorization and lifecycle boundary.",
	},
};

async function dispatchRootRoute({ params, request, set, user, profile, body }: PluginRouteContext) {
	return await handlePluginRouteDispatch({
		pluginId: params.pluginId,
		path: "/",
		request,
		set,
		user,
		profile,
		body,
	});
}

async function dispatchNestedRoute({ params, request, set, user, profile, body }: PluginRouteContext) {
	return await handlePluginRouteDispatch({
		pluginId: params.pluginId,
		path: `/${params["*"] ?? ""}`,
		request,
		set,
		user,
		profile,
		body,
	});
}

export const pluginsRoutes = new Elysia({ prefix: "/plugins", tags: ["Plugins"] })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.guard({ auth: true })
	.get(
		"",
		() => {
			return pluginManager.getStatus();
		},
		{
			response: {
				200: t.Array(PluginRuntimeStatusSchema),
			},
			detail: {
				description: "Lists all installed plugins and their lifecycle states.",
			},
		},
	)
	// Each method is registered on its own, not with `.all`: Elysia matches a request's method before it
	// tries any-method routes, and the bundled web UI's GET catch-all would otherwise take every plugin GET.
	.get("/:pluginId", dispatchRootRoute, rootRouteOptions)
	.post("/:pluginId", dispatchRootRoute, rootRouteOptions)
	.put("/:pluginId", dispatchRootRoute, rootRouteOptions)
	.patch("/:pluginId", dispatchRootRoute, rootRouteOptions)
	.delete("/:pluginId", dispatchRootRoute, rootRouteOptions)
	.get("/:pluginId/*", dispatchNestedRoute, nestedRouteOptions)
	.post("/:pluginId/*", dispatchNestedRoute, nestedRouteOptions)
	.put("/:pluginId/*", dispatchNestedRoute, nestedRouteOptions)
	.patch("/:pluginId/*", dispatchNestedRoute, nestedRouteOptions)
	.delete("/:pluginId/*", dispatchNestedRoute, nestedRouteOptions);

async function handlePluginRouteDispatch({
	pluginId,
	path,
	request,
	set,
	user,
	profile,
	body,
}: {
	pluginId: string;
	path: string;
	request: Request;
	set: { status?: number | keyof StatusMap; headers: HTTPHeaders };
	user: { id?: string; role?: string } | null | undefined;
	profile?: { id: string } | null | undefined;
	body?: unknown;
}) {
	let parsedBody = body;
	if (parsedBody === undefined) {
		parsedBody = await parseJsonBody(request);
	}
	const headersObj: Record<string, string> = {};
	for (const [key, value] of request.headers.entries()) {
		headersObj[key.toLowerCase()] = value;
	}
	const result = await pluginRouteDispatchService.dispatch({
		pluginId,
		method: request.method,
		path,
		query: Object.fromEntries(new URL(request.url).searchParams),
		headers: headersObj,
		body: parsedBody,
		user: { id: user?.id ?? "", role: user?.role ?? "user", ...(profile ? { profileId: profile.id } : {}) },
	});
	if (result.type === "not_found") throw new DomainError("not_found", "Plugin route not found", { code: "plugin.route_not_found" });

	if (result.type === "forbidden") throw new DomainError("forbidden", result.message, { code: "plugin.route_forbidden" });

	if (result.type === "invalid_request") throw new DomainError("validation", result.message, { code: "plugin.route_request_invalid" });

	if (result.headers) {
		for (const [key, value] of Object.entries(result.headers)) {
			if (FORBIDDEN_PLUGIN_RESPONSE_HEADERS.has(key.toLowerCase())) continue;

			set.headers[key] = value;
		}
	}

	set.status = result.status;

	return result.body;
}

async function parseJsonBody(request: Request): Promise<unknown> {
	if (!request.headers.get("content-type")?.includes("application/json")) return undefined;

	try {
		return await request.json();
	} catch {
		return undefined;
	}
}
