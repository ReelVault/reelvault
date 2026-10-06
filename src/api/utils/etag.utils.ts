import { hash as bunHash } from "bun";
import { serverConfig } from "@/server.config";
import { compressBuffer, negotiateEncoding } from "@/utils/compression.utils";
import { matchesIfNoneMatch } from "@/utils/http.utils";
import { cacheEtagBody, getCachedEtagEntry } from "@/utils/response-body-cache";

/** Per-profile aggregation responses must be revalidated by the browser on every use. */
const ETAG_CACHE_CONTROL = "private, no-cache";
const ETAG_VARY = "Accept-Encoding, Cookie";

/**
 * ETag for a serialized JSON body. bunHash, same as response-cache — ETags are
 * only revalidation hints for the uncompressed representation, and SHA-256
 * cost 3-5x more.
 */
export function jsonEtag(body: string): string {
	return `"${bunHash(body).toString(16)}"`;
}

export interface JsonResponseOptions {
	body: string;
	etag: string;
	cacheControl: string;
	vary: string;
	acceptEncoding: string;
	ifNoneMatch: string | null | undefined;
	/** When provided, compressed variants are memoized here (response-cache hits). */
	encoded?: Map<string, Uint8Array<ArrayBuffer>> | undefined;
}

/**
 * Materializes a JSON body into a Response: a body-less 304 on a matching
 * If-None-Match, otherwise a 200 with negotiated compression. Shared by the
 * response-cache middleware and withEtagResponse() so ETag/304/compression
 * semantics cannot drift between the two paths.
 */
export async function buildJsonResponse(options: JsonResponseOptions): Promise<Response> {
	const headers = new Headers({
		ETag: options.etag,
		Vary: options.vary,
		"Cache-Control": options.cacheControl,
		"Content-Type": "application/json; charset=utf-8",
	});

	if (matchesIfNoneMatch(options.ifNoneMatch, options.etag)) {
		return new Response(null, { status: 304, headers });
	}

	const encoding = negotiateEncoding(options.acceptEncoding);
	if (encoding && options.body.length >= serverConfig.compression.minSizeBytes) {
		let compressed = options.encoded?.get(encoding);
		if (!compressed) {
			compressed = Uint8Array.from(await compressBuffer(Buffer.from(options.body), encoding));
			options.encoded?.set(encoding, compressed);
		}

		headers.set("Content-Encoding", encoding);

		return new Response(compressed, { status: 200, headers });
	}

	return new Response(options.body, { status: 200, headers });
}

/**
 * JSON ETag/304 revalidation for profile-scoped GET responses.
 *
 * Returns a Response (200 JSON on miss, body-less 304 on a matching
 * If-None-Match, skipping serialization). Sets ETag + Vary: Accept-Encoding,
 * Cookie (per-profile correctness) + private no-cache. The payload shape stays
 * TS-checked at the service boundary — Elysia response-schema validation does
 * not apply to pre-serialized Response returns, and the Response return type is
 * required by the composed handler typing of routes with global afterHandle
 * plugins (rate limiting).
 *
 * Compression happens HERE, not in the compression middleware: mapResponse
 * never sees these bodies (the handler returns a Response directly), and
 * returning a replacement Response from mapResponse is ignored when the
 * handler already returned one.
 *
 * Pass `cacheKey` for expensive aggregations to serve repeat requests from the
 * shared body cache (keyed per profile by the caller). Cached entries store
 * the UNCOMPRESSED body; the encoding is applied per response — do not
 * memoize compressed variants here: measured 2026-09-21, skipping the per-hit
 * compress lost the zlib threadpool pipelining and cost ~8.5% req/s at c=50
 * despite winning ~17% at c=10.
 */
export async function withEtagResponse<T>(
	request: Request,
	set: { headers: Record<string, unknown> },
	load: () => Promise<T>,
	options?: { cacheKey?: string },
): Promise<Response> {
	const ifNoneMatch = request.headers.get("if-none-match");
	const acceptEncoding = request.headers.get("accept-encoding") ?? "";

	const respond = async (body: string, etag: string): Promise<Response> => {
		set.headers.ETag = etag;
		set.headers.Vary = ETAG_VARY;
		set.headers["Cache-Control"] = ETAG_CACHE_CONTROL;

		return await buildJsonResponse({
			body,
			etag,
			cacheControl: ETAG_CACHE_CONTROL,
			vary: ETAG_VARY,
			acceptEncoding,
			ifNoneMatch,
		});
	};

	if (options?.cacheKey) {
		const cached = getCachedEtagEntry(options.cacheKey);
		if (cached) return await respond(cached.body, cached.etag);
	}

	// Load lazily: a body-cache hit must not run the aggregation at all.
	const resolved = await load();
	const body = JSON.stringify(resolved);
	const etag = jsonEtag(body);

	if (options?.cacheKey) cacheEtagBody(options.cacheKey, body, etag);

	return await respond(body, etag);
}
