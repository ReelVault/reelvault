import { Elysia } from "elysia";
import { isImageAssetPath, isPluginUiPath, isWebApiPath } from "@/api/utils/route-classification.utils";
import { serverConfig } from "@/server.config";
import { getPathname } from "@/utils/http.utils";
import { isFiniteNumber } from "@/utils/type.utils";
import { resolveWebDistRoot } from "@/web/web-dist";

export const securityHeadersMiddleware = new Elysia({ name: "SecurityHeaders" }).onAfterHandle({ as: "global" }, ({ request, set }) => {
	if (request.method === "OPTIONS") return;

	const path = getPathname(request.url);
	const isOpenApiUi = path === serverConfig.api.openapi.path;
	// Plugin UI bundles are embedded cross-origin by the host website; the
	// default `frame-ancestors 'none'` / `X-Frame-Options: DENY` would block them.
	const isPluginUi = isPluginUiPath(request.url);
	// The server-hosted SPA needs a policy that actually lets its own assets
	// load; every non-web path keeps the locked-down default.
	const isWebUi = resolveWebDistRoot() !== null && !isPluginUi && !isOpenApiUi && !isWebApiPath(request.url);

	set.headers["X-Content-Type-Options"] = serverConfig.security.contentTypeOptions;
	if (!isPluginUi) set.headers["X-Frame-Options"] = serverConfig.security.frameOptions;

	set.headers["Referrer-Policy"] = serverConfig.security.referrerPolicy;
	let contentSecurityPolicy = serverConfig.security.defaultContentSecurityPolicy;
	if (isPluginUi) contentSecurityPolicy = serverConfig.security.pluginUiContentSecurityPolicy;
	else if (isOpenApiUi) contentSecurityPolicy = serverConfig.security.openApiContentSecurityPolicy;
	else if (isWebUi) contentSecurityPolicy = serverConfig.security.webUiContentSecurityPolicy;

	set.headers["Content-Security-Policy"] = contentSecurityPolicy;
	set.headers["Permissions-Policy"] = serverConfig.security.permissionsPolicy;

	if (request.url.startsWith("https:")) set.headers["Strict-Transport-Security"] = `max-age=${serverConfig.security.hstsMaxAgeSeconds}`;

	const existingCacheControl = set.headers["Cache-Control"] ?? set.headers["cache-control"];
	const isImageResponse = request.method === "GET" && isImageAssetPath(request.url);
	const statusCode = Number(set.status);
	const isErrorResponse = isFiniteNumber(statusCode) && statusCode >= 400;

	if (isErrorResponse || !(existingCacheControl || isImageResponse)) {
		set.headers["Cache-Control"] = serverConfig.security.cacheControl;
	}
});
