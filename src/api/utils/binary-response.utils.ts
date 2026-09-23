/**
 * Shared helpers for serving binary files (images, subtitles) with ETag-based
 * conditional requests. Previously duplicated between images.routes.ts and
 * subtitles.routes.ts.
 */

function binaryFileEtag(file: Blob): string | undefined {
	const lastModified = "lastModified" in file && typeof file.lastModified === "number" ? file.lastModified : undefined;
	if (file.size === 0 || lastModified === undefined) return undefined;

	return `"${file.size}-${Math.floor(lastModified)}"`;
}

function matchesIfNoneMatch(ifNoneMatch: string | null | undefined, etag: string): boolean {
	if (!ifNoneMatch) return false;

	return ifNoneMatch.split(",").some((candidate) => {
		const value = candidate.trim();

		return value === etag || value === `W/${etag}`;
	});
}

function toBinaryResponse(
	body: Blob | null,
	contentType: string,
	etag: string | undefined,
	cacheControl: string,
	status: 200 | 304 = 200,
): Response {
	const headers: Record<string, string> = {
		"Content-Type": contentType,
		"Cache-Control": cacheControl,
		Vary: "Accept-Encoding",
	};
	if (etag) headers.ETag = etag;

	return new Response(body, { status, headers });
}

/**
 * Full conditional-request handling for a binary file: computes the ETag,
 * answers 304 when `ifNoneMatch` matches, otherwise returns the 200 response.
 */
export function binaryFileResponse(
	file: Blob,
	contentType: string,
	cacheControl: string,
	ifNoneMatch: string | null | undefined,
): Response {
	const etag = binaryFileEtag(file);
	if (etag && matchesIfNoneMatch(ifNoneMatch, etag)) {
		return toBinaryResponse(null, contentType, etag, cacheControl, 304);
	}

	return toBinaryResponse(file, contentType, etag, cacheControl);
}
