import { matchesIfNoneMatch } from "@/utils/http.utils";

/**
 * Shared helpers for serving binary files (images, subtitles, plugin UI
 * assets) with ETag-based conditional requests.
 */

function binaryFileEtag(file: Blob): string | undefined {
	const lastModified = "lastModified" in file && typeof file.lastModified === "number" ? file.lastModified : undefined;
	if (file.size === 0 || lastModified === undefined) return undefined;

	return `"${file.size}-${Math.floor(lastModified)}"`;
}

function toBinaryResponse(
	body: Blob | null,
	contentType: string,
	etag: string | undefined,
	cacheControl: string,
	status: 200 | 304,
	extraHeaders?: HeadersInit,
): Response {
	const headers = new Headers(extraHeaders);
	headers.set("Content-Type", contentType);
	headers.set("Cache-Control", cacheControl);
	headers.set("Vary", "Accept-Encoding");
	if (etag) headers.set("ETag", etag);

	return new Response(body, { status, headers });
}

export interface BinaryResponseOptions {
	/**
	 * Extra headers merged into the response (e.g. CORS headers carried over
	 * from `set.headers`). The helper's own ETag/Cache-Control/Vary/Content-Type
	 * always win on conflict.
	 */
	headers?: HeadersInit | undefined;
}

/**
 * Full conditional-request handling for a binary file: computes the
 * mtime-based ETag, answers 304 when `ifNoneMatch` matches (comma-separated
 * lists and weak validators included), otherwise returns the 200 response.
 */
export function binaryFileResponse(
	file: Blob,
	contentType: string,
	cacheControl: string,
	ifNoneMatch: string | null | undefined,
	options?: BinaryResponseOptions,
): Response {
	const etag = binaryFileEtag(file);
	if (etag && matchesIfNoneMatch(ifNoneMatch, etag)) {
		return toBinaryResponse(null, contentType, etag, cacheControl, 304, options?.headers);
	}

	return toBinaryResponse(file, contentType, etag, cacheControl, 200, options?.headers);
}
