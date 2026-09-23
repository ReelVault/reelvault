import { PluginRuntimeStatusSchema } from "@sdk/common/plugins";
import Elysia, { type HTTPHeaders, type StatusMap, t } from "elysia";
import { commonModel } from "@/api/schemas/common.schemas";
import { PluginIdParams } from "@/api/schemas/route-params";
import { pluginsService } from "@/application/plugins.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";
import { ForbiddenError, NotFoundError, ValidationError } from "@/utils/errors";

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

export const pluginsRoutes = new Elysia({ prefix: "/plugins", tags: ["Plugins"] })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.guard({ auth: true })
	.get(
		"",
		() => {
			return pluginsService.getStatus();
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
	.all(
		"/:pluginId",
		async ({ params, request, set, user, profile, body }) => {
			return await handlePluginRouteDispatch({
				pluginId: params.pluginId,
				path: "/",
				request,
				set,
				user,
				profile,
				body,
			});
		},
		{
			// Plugin-owned routes can do arbitrary work; bound them per profile so a
			// single account cannot hammer any plugin endpoint. The global limiter
			// only exempts playback segments, so this is additive.
			rateLimit: { name: "plugin-route", max: 300, windowMs: MINUTE },
			params: PluginIdParams,
			// Plugin-owned payload: the plugin's declared response schema validates it.
			response: t.Unknown(),
			detail: {
				description: "Dispatches a root declared plugin route.",
			},
		},
	)
	.all(
		"/:pluginId/*",
		async ({ params, request, set, user, profile, body }) => {
			const wildcard = (params as Record<string, string>)["*"] ?? "";

			return await handlePluginRouteDispatch({
				pluginId: params.pluginId,
				path: `/${wildcard}`,
				request,
				set,
				user,
				profile,
				body,
			});
		},
		{
			rateLimit: { name: "plugin-route", max: 300, windowMs: MINUTE },
			// No params schema here: Elysia's exactMirror cannot compile a TypeBox
			// object that owns the "*" wildcard key, which silently kills this route.
			// pluginId is re-validated inside the dispatch instead.
			// Plugin-owned payload: the plugin's declared response schema validates it.
			response: t.Unknown(),
			detail: {
				description: "Dispatches a declared plugin route through the core authorization and lifecycle boundary.",
			},
		},
	);

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
	const parsedBody = body !== undefined ? body : await parseJsonBody(request);
	const headersObj: Record<string, string> = {};
	request.headers.forEach((value, key) => {
		headersObj[key.toLowerCase()] = value;
	});
	const result = await pluginsService.dispatchRoute({
		pluginId,
		method: request.method,
		path,
		query: Object.fromEntries(new URL(request.url).searchParams),
		headers: headersObj,
		body: parsedBody,
		user: { id: user?.id ?? "", role: user?.role ?? "user", ...(profile ? { profileId: profile.id } : {}) },
	});
	if (result.type === "not_found") throw new NotFoundError("Plugin route not found");

	if (result.type === "forbidden") throw new ForbiddenError(result.message);

	if (result.type === "invalid_request") throw new ValidationError(result.message);

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
