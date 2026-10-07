import { serverConstants } from "@/server.constants";

/**
 * Single source of route-shape classification shared by auth, rate-limit and
 * security middleware — a new public prefix gets added here once, not once per
 * middleware (they must stay in sync; see AGENTS.md auth exemptions).
 *
 * All classifiers take the already-extracted pathname (`getPathname`), so a
 * request parses its URL once instead of once per classifier.
 */

export const isImageAssetPath = (pathname: string): boolean => pathname.startsWith(serverConstants.security.imageRoutePrefix);

export const isPluginUiPath = (pathname: string): boolean => pathname.startsWith(serverConstants.security.pluginUiRoutePrefix);

/**
 * Prefixes owned by the API router and the API docs. The web static plugin
 * yields on these so unknown /v1 & /openapi paths keep the JSON 404 envelope.
 * Keep in sync with the apiRouter prefix and serverConfig.api.openapi.path.
 */
const webApiPathPrefixes: readonly string[] = ["/v1", "/openapi"];

export const isWebApiPath = (pathname: string): boolean =>
	webApiPathPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
