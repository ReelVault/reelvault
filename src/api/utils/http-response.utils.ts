/** A body-less 304 answering a conditional GET; the headers repeat the validators the client already holds. */
export function notModifiedResponse(headers: HeadersInit): Response {
	return new Response(null, { status: 304, headers });
}

/** Copies the string-valued entries of a headers record (e.g. Elysia's `set.headers`) into a Headers object. */
export function headersFromRecord(record: Record<string, unknown>): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(record)) {
		if (typeof value === "string") headers.set(key, value);
	}

	return headers;
}
