import { notModifiedResponse } from "@/api/utils/http-response.utils";
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

interface BinaryHeadersInit {
	contentType: string;
	etag: string | undefined;
	cacheControl: string;
	extraHeaders?: HeadersInit | undefined;
}

function binaryHeaders({ contentType, etag, cacheControl, extraHeaders }: BinaryHeadersInit): Headers {
	const headers = new Headers(extraHeaders);
	headers.set("Content-Type", contentType);
	headers.set("Cache-Control", cacheControl);
	headers.set("Vary", "Accept-Encoding");
	if (etag) headers.set("ETag", etag);

	return headers;
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
	const headers = binaryHeaders({ contentType, etag, cacheControl, extraHeaders: options?.headers });
	if (etag && matchesIfNoneMatch(ifNoneMatch, etag)) return notModifiedResponse(headers);

	return new Response(file, { status: 200, headers });
}

export interface AttachmentResponseOptions {
	filename: string;
	contentType: string;
	/** Encode per RFC 5987 (`filename*=UTF-8''…`) instead of the quoted form, for non-ASCII names. */
	rfc5987?: boolean | undefined;
	headers?: HeadersInit | undefined;
}

/** Response carrying a downloadable payload with a `Content-Disposition: attachment` header. */
export function attachmentResponse(body: BodyInit | null, options: AttachmentResponseOptions): Response {
	const disposition = options.rfc5987
		? `attachment; filename*=UTF-8''${encodeURIComponent(options.filename)}`
		: `attachment; filename="${options.filename}"`;
	const headers = new Headers(options.headers);
	headers.set("Content-Type", options.contentType);
	headers.set("Content-Disposition", disposition);

	return new Response(body, { status: 200, headers });
}
