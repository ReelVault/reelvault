import { hash as bunHash } from "bun";
import { serverConfig } from "@/server.config";
import { compressBuffer, negotiateEncoding } from "@/utils/compression.utils";
import { cacheEtagBody, getCachedEtagBody } from "@/utils/response-body-cache";

/**
 * JSON ETag/304 revalidation for profile-scoped GET responses.
 *
 * Returns a Response (200 JSON on miss, body-less 304 on a matching
 * If-None-Match, skipping serialization). Sets ETag + Vary: Cookie (per-profile
 * correctness) + private no-cache. The payload shape stays TS-checked at the
 * service boundary — Elysia response-schema validation does not apply to
 * pre-serialized Response returns, and the Response return type is required by
 * the composed handler typing of routes with global afterHandle plugins
 * (rate limiting).
 *
 * Compression happens HERE, not in the compression middleware: mapResponse
 * never sees these bodies (the handler returns a Response directly), and
 * returning a replacement Response from mapResponse is ignored when the
 * handler already returned one.
 *
 * Pass `cacheKey` for expensive aggregations to serve repeat requests from the
 * short-lived body cache (keyed per profile by the caller). Cached entries
 * store the UNCOMPRESSED body; the encoding is applied per response — do not
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
	const encoding = negotiateEncoding(request.headers.get("accept-encoding") ?? "");
	const minSize = serverConfig.compression.minSizeBytes;

	const buildResponse = async (body: string): Promise<Response> => {
		// bunHash, same as response-cache — ETags here are only revalidation hints
		// for the uncompressed representation, and SHA-256 cost 3-5x more.
		const etag = `"${bunHash(body).toString(16)}"`;
		const baseHeaders: Record<string, string> = {
			ETag: etag,
			Vary: "Cookie, Accept-Encoding",
			"Cache-Control": "private, no-cache",
		};
		set.headers.ETag = etag;
		set.headers.Vary = baseHeaders.Vary;
		set.headers["Cache-Control"] = baseHeaders["Cache-Control"];

		if (ifNoneMatch === etag) {
			return new Response(null, { status: 304, headers: baseHeaders });
		}

		if (encoding && body.length >= minSize) {
			const compressed = await compressBuffer(Buffer.from(body), encoding);

			return new Response(Uint8Array.from(compressed), {
				status: 200,
				headers: { ...baseHeaders, "Content-Type": "application/json", "Content-Encoding": encoding },
			});
		}

		return new Response(body, { status: 200, headers: { ...baseHeaders, "Content-Type": "application/json" } });
	};

	if (options?.cacheKey) {
		const cached = getCachedEtagBody(options.cacheKey);
		if (cached !== undefined) return await buildResponse(cached);
	}

	// Load lazily: a body-cache hit must not run the aggregation at all.
	const resolved = await load();
	const body = JSON.stringify(resolved);

	if (options?.cacheKey) cacheEtagBody(options.cacheKey, body);

	return await buildResponse(body);
}
