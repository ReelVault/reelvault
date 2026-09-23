import type { PluginRuntimeStatus } from "@sdk/common/plugins";
import type { PluginUiManifestResponse } from "@sdk/plugin";
import { BaseResource } from "../core/base-resource";

export class PluginsClient extends BaseResource {
	list(): Promise<PluginRuntimeStatus[]> {
		return this._get<PluginRuntimeStatus[]>("/plugins");
	}

	getUiManifest(): Promise<PluginUiManifestResponse> {
		return this._get<PluginUiManifestResponse>("/plugins/ui/manifest");
	}

	call<TResponse = unknown>(
		pluginId: string,
		path: string,
		options?: { method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"; body?: unknown; query?: Record<string, string> },
	): Promise<TResponse> {
		const method = options?.method ?? (options?.body ? "POST" : "GET");
		const cleanPath = safePluginCallPath(path);
		if (cleanPath instanceof Error) return Promise.reject(cleanPath);

		const url = `/plugins/${pluginId}/${cleanPath}`;

		switch (method) {
			case "POST":
				return this._post<TResponse>(url, { body: options?.body, query: options?.query });
			case "PUT":
				return this._put<TResponse>(url, { body: options?.body, query: options?.query });
			case "PATCH":
				return this._patch<TResponse>(url, { body: options?.body, query: options?.query });
			case "DELETE":
				return this._delete<TResponse>(url, { query: options?.query });
			case "GET":
				return this._get<TResponse>(url, { query: options?.query });
			default:
				return this._get<TResponse>(url, { query: options?.query });
		}
	}
}

const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Plugin API paths are addressed relative to `/v1/plugins/<pluginId>/`. Reject
 * anything that could escape that prefix (absolute URL, `//host`, `..`, a
 * query/fragment, backslashes) so a malicious schema cannot make an admin's
 * authenticated browser call arbitrary host endpoints.
 */
function safePluginCallPath(path: string): string | Error {
	const cleanPath = path.startsWith("/") ? path.slice(1) : path;
	if (
		cleanPath.length === 0 ||
		cleanPath.startsWith("/") ||
		cleanPath.includes("..") ||
		cleanPath.includes("\\") ||
		cleanPath.includes("?") ||
		cleanPath.includes("#") ||
		URL_SCHEME_PREFIX.test(cleanPath)
	) {
		return new Error("Plugin path must be relative to the plugin namespace");
	}

	return cleanPath;
}
