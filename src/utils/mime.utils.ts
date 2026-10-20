import { getExtension } from "@/utils/path.utils";

/**
 * The one extension→MIME table for static assets: the web bundle and plugin UI
 * bundles both serve from it. Consumers keep their own servable-extension
 * allowlists where serving is a security decision (plugin directories also
 * contain `config.json`).
 */
export const MIME_TYPES: Readonly<Record<string, string>> = {
	".avif": "image/avif",
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".htm": "text/html; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".mjs": "text/javascript; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
	".vtt": "text/vtt; charset=utf-8",
	".wasm": "application/wasm",
	".webmanifest": "application/manifest+json",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

/** MIME type for a file path's extension, `application/octet-stream` when unknown. */
export function contentTypeForPath(filePath: string): string {
	return MIME_TYPES[getExtension(filePath)] ?? "application/octet-stream";
}
