export interface ByteRange {
	/** First byte offset (0-based, inclusive). */
	start: number;
	/** Last byte offset (inclusive). */
	end: number;
}

const BYTES_RANGE_REGEX = /^bytes=(\d*)-(\d*)$/;

/**
 * RFC 9110 single-range parser for `Range: bytes=...` headers.
 * Returns undefined when the request should be served in full (no header, a
 * multi-range request, or an unsupported unit) and "invalid" when the header
 * is syntactically valid but unsatisfiable (HTTP 416).
 * A suffix longer than the resource resolves to the whole resource, per spec.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | "invalid" | undefined {
	if (!header || size <= 0) return undefined;

	const match = BYTES_RANGE_REGEX.exec(header.trim());
	if (!match) return undefined;

	const rawStart = match[1] ?? "";
	const rawEnd = match[2] ?? "";
	if (rawStart === "" && rawEnd === "") return undefined;

	// Suffix form `-N`: the last N bytes.
	if (rawStart === "") {
		const suffixLength = Number.parseInt(rawEnd, 10);
		if (suffixLength === 0) return "invalid";

		return { start: Math.max(0, size - suffixLength), end: size - 1 };
	}

	const start = Number.parseInt(rawStart, 10);
	if (start >= size) return "invalid";

	const end = rawEnd === "" ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1);
	if (end < start) return "invalid";

	return { start, end };
}

/** Value for the `Content-Range` header of a 206 response. */
export function contentRangeFor(range: ByteRange, size: number): string {
	return `bytes ${range.start}-${range.end}/${size}`;
}

/**
 * Builds the 206/416 response for a ranged request over a blob (Bun's file
 * handles are Blobs, so slicing stays minimal-copy). Returns undefined when
 * the caller should serve the resource in full.
 */
export function byteRangeResponse(blob: Blob, rangeHeader: string | null, baseHeaders: Record<string, string>): Response | undefined {
	const range = parseByteRange(rangeHeader, blob.size);
	if (range === undefined) return undefined;

	if (range === "invalid") {
		return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${blob.size}` } });
	}

	return new Response(blob.slice(range.start, range.end + 1), {
		status: 206,
		headers: { ...baseHeaders, "Content-Range": contentRangeFor(range, blob.size) },
	});
}
