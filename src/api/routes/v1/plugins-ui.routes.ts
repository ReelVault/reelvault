import { file } from "bun";
import Elysia, { t } from "elysia";
import { authMiddleware } from "@/middleware/auth.middleware";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { serverConfig } from "@/server.config";
import { ForbiddenError, NotFoundError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".vtt": "text/vtt; charset=utf-8",
};

/** UI assets are an allowlist — plugin sources and config.json (may hold secrets) never leave the plugin dir. */
const SERVABLE_EXTENSIONS = new Set(Object.keys(MIME_TYPES));

/** Bound the upward search for a plugin SPA entry so a bad request cannot walk the filesystem. */
const MAX_SPA_FALLBACK_DEPTH = 8;

function getMimeType(filePath: string): string {
	const ext = PathUtils.getExtension(filePath);

	return MIME_TYPES[ext] ?? "application/octet-stream";
}

function safePath(base: string, relative: string): string | null {
	const resolved = PathUtils.resolve(base, relative);
	if (!PathUtils.isSubpath(resolved, base)) return null;

	return resolved;
}

/**
 * Resolves an extension-less SPA route to the nearest `index.html` inside the
 * plugin directory (e.g. `dist/ui/report/42` → `dist/ui/report/index.html`),
 * so history-routed bundles work regardless of their entry depth.
 */
async function resolveSpaFallback(pluginDir: string, resolved: string): Promise<string | null> {
	const root = PathUtils.resolve(pluginDir);
	let current = resolved;

	for (let depth = 0; depth <= MAX_SPA_FALLBACK_DEPTH; depth++) {
		const candidate = PathUtils.join(current, "index.html");
		if (await FileUtils.exists(candidate)) return candidate;

		if (current === root) return null;

		const parent = PathUtils.getDirName(current);
		if (parent === current || !PathUtils.isSubpath(current, root)) return null;

		current = parent;
	}

	return null;
}

export const pluginsUiRoutes = new Elysia({ prefix: "/plugins/ui", tags: ["Plugin UI"] })
	.use(authMiddleware)
	.get(
		"/manifest",
		({ user }) => {
			// Admin-only surfaces are removed for regular users before the manifest
			// ever reaches the browser — the host never has to gate visibility.
			const manifests = pluginRegistry.getUiManifestsForRole(user?.role === "admin");

			return { plugins: manifests };
		},
		{
			// The manifest is role-filtered, so it requires a session. Asset routes
			// below are public: they are secret-free static bundles imported
			// cross-origin as ESM modules (browsers omit credentials there).
			auth: true,
			response: {
				// Manifest bodies are plugin-defined and validated at load time
				// (validatePluginUiManifest), so the envelope only pins the record shape.
				200: t.Object({ plugins: t.Record(t.String(), t.Unknown()) }),
			},
			detail: {
				description: "Returns aggregated UI manifests from all enabled plugins, filtered by caller role.",
			},
		},
	)
	.get(
		"/:pluginId/*",
		async ({ params, set, request }) => {
			const pluginId = params.pluginId;
			const filePath = params["*"];

			// Resolve the directory via the loader's id→directory index — the manifest
			// id is NOT the directory name ("org.reelvault.x" lives in "x/").
			const directoryName = await pluginManager.getPluginDirectoryName(pluginId);
			if (!directoryName) {
				throw new NotFoundError(`Plugin not found: ${pluginId}`, { code: "plugin.not_found", params: { pluginId } });
			}

			const pluginDir = PathUtils.join(serverConfig.paths.plugins, directoryName);

			const resolved = safePath(pluginDir, filePath);
			if (!resolved) {
				throw new ForbiddenError("Plugin UI asset path is not allowed", { code: "plugin_ui.forbidden", params: { pluginId } });
			}

			const extension = PathUtils.getExtension(resolved);
			// config.json lives in the same directory and may hold provider secrets.
			if (extension && !SERVABLE_EXTENSIONS.has(extension)) {
				throw new ForbiddenError("Plugin UI asset type is not servable", { code: "plugin_ui.forbidden", params: { pluginId } });
			}

			let assetPath = resolved;
			if (!(await FileUtils.exists(assetPath))) {
				// Extension-less request → SPA deep link, serve the nearest index.html.
				assetPath = extension ? "" : ((await resolveSpaFallback(pluginDir, resolved)) ?? "");
				if (!assetPath) {
					throw new NotFoundError(`Plugin UI asset not found: ${filePath}`, {
						code: "plugin_ui.asset_not_found",
						params: { pluginId },
					});
				}
			}

			// Serve the BunFile directly (Bun streams it from disk). Headers are set
			// on the Response so they survive even though the handler returns its own
			// Response: plugin elements are imported cross-origin by the website, so
			// CORS headers from the global cors middleware must be carried over exactly
			// once (duplicate `Access-Control-Allow-Origin` is a CORS failure).
			const pluginFile = file(assetPath);
			const headers = new Headers();
			for (const [key, value] of Object.entries(set.headers)) {
				if (typeof value === "string") headers.set(key, value);
			}

			headers.set("content-type", getMimeType(assetPath));
			if (!headers.has("access-control-allow-origin")) headers.set("access-control-allow-origin", "*");

			// Plugins are replaced in place (same URL). `no-cache` + a cheap
			// size/mtime ETag makes the browser revalidate every import, so a rebuilt
			// bundle is picked up immediately instead of after a 1 h max-age.
			const stats = await FileUtils.getStats(assetPath);
			if (stats) {
				const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
				headers.set("etag", etag);
				headers.set("cache-control", "no-cache");
				if (request.headers.get("if-none-match") === etag) {
					return new Response(null, { status: 304, headers });
				}
			} else {
				headers.set("cache-control", "no-cache");
			}

			return new Response(pluginFile, { headers });
		},
		{
			// No explicit params schema: TypeBox/Elysia cannot mirror a wildcard
			// (`*`) key, which produced "Failed to create exactMirror" and a 404.
			detail: {
				description: "Serves static UI files (with SPA fallback) from a plugin's directory.",
			},
		},
	);
