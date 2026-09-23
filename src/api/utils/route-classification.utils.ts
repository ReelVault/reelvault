import { serverConstants } from "@/server.constants";
import { getPathname } from "@/utils/http.utils";

/**
 * Single source of route-shape classification shared by auth, rate-limit and
 * security middleware — a new public prefix gets added here once, not once per
 * middleware (they must stay in sync; see AGENTS.md auth exemptions).
 */

export const isImageAssetPath = (url: string): boolean => getPathname(url).startsWith(serverConstants.security.imageRoutePrefix);

export const isPluginUiPath = (url: string): boolean => getPathname(url).startsWith(serverConstants.security.pluginUiRoutePrefix);

/**
 * Prefixes owned by the API router and the API docs. The web static plugin
 * yields on these so unknown /v1 & /openapi paths keep the JSON 404 envelope.
 * Keep in sync with the apiRouter prefix and serverConfig.api.openapi.path.
 */
const webApiPathPrefixes: readonly string[] = ["/v1", "/openapi"];

export const isWebApiPath = (url: string): boolean => {
	const pathname = getPathname(url);

	return webApiPathPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
};
