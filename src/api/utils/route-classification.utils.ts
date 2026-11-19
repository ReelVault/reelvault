import { API_ROUTER_PREFIX } from "@/api/api.constants";
import { serverConstants } from "@/config/server/server.constants";

/**
 * Single source of route-shape classification shared by auth, rate-limit and
 * security middleware — a new public prefix gets added here once, not once per
 * middleware (they must stay in sync; see AGENTS.md auth exemptions).
 *
 * All classifiers take the already-extracted pathname (`getPathname`), so a
 * request parses its URL once instead of once per classifier.
 */

export function isImageAssetPath(pathname: string): boolean {
	return pathname.startsWith(serverConstants.security.imageRoutePrefix);
}

/** The immutable asset bundle of the SPA served by the server itself. */
export function isWebAssetPath(pathname: string): boolean {
	return pathname.startsWith(serverConstants.security.webAssetRoutePrefix);
}

export function isPluginUiPath(pathname: string): boolean {
	return pathname.startsWith(serverConstants.security.pluginUiRoutePrefix);
}

/** The plugin UI manifest: role-filtered, so it stays behind authentication. */
export function isPluginUiManifestPath(pathname: string): boolean {
	return pathname === `${serverConstants.security.pluginUiRoutePrefix}manifest`;
}

/** The health probes, which are exempt from the global rate limit. */
export function isHealthPath(pathname: string): boolean {
	return pathname === "/v1/health" || pathname.startsWith("/v1/health/");
}

/** The HLS segment route: a player fetches many segments per second, so it is exempt from the global limit. */
export function isPlaybackSegmentPath(pathname: string): boolean {
	return pathname.startsWith("/v1/playback-sessions/") && pathname.includes("/segments/");
}

/** Paths under the versioned API router. */
export function isV1Path(pathname: string): boolean {
	return pathname.startsWith("/v1/");
}

/**
 * Prefixes owned by the API router and the API docs. The web static plugin
 * yields on these so unknown API & docs paths keep the JSON 404 envelope.
 */
const webApiPathPrefixes: readonly string[] = [API_ROUTER_PREFIX, serverConstants.api.openapi.path];

export function isWebApiPath(pathname: string): boolean {
	return webApiPathPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
