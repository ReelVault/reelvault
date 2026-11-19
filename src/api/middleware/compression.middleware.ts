import { Elysia } from "elysia";
import { headersFromRecord } from "@/api/utils/http-response.utils";
import { serverConfig } from "@/config/server/server.config";
import { compressBuffer, negotiateEncoding } from "@/utils/compression.utils";
import { getResponseStatus } from "@/utils/http.utils";
import { isRecord, normalizeLower } from "@/utils/type.utils";
import { serializedBodyCache } from "./serialized-body.cache";

function matchesType(contentType: string, pattern: string): boolean {
	if (pattern.endsWith("/*")) return contentType.startsWith(pattern.slice(0, -2));

	return contentType === pattern;
}

const compressibleTypes = new Set(serverConfig.compression.types);
const excludedTypes = new Set(serverConfig.compression.excludeTypes);

function shouldCompress(contentType: string, size: number): boolean {
	if (size < serverConfig.compression.minSizeBytes) return false;

	const separator = contentType.indexOf(";");
	const mimeType = normalizeLower(separator === -1 ? contentType : contentType.slice(0, separator));
	for (const t of excludedTypes) {
		if (matchesType(mimeType, t)) return false;
	}

	for (const t of compressibleTypes) {
		if (matchesType(mimeType, t)) return true;
	}

	return false;
}

/**
 * The bytes a route response carries, and the content type it gets when the
 * route did not set one. Undefined for values that are not a body (streams,
 * records of no known shape).
 */
function responseBodyBytes(responseValue: unknown) {
	if (typeof responseValue === "string") {
		return { bytes: Buffer.from(responseValue), defaultContentType: "text/plain; charset=utf-8" };
	}

	if (responseValue instanceof Uint8Array) {
		return {
			bytes: Buffer.from(responseValue.buffer, responseValue.byteOffset, responseValue.byteLength),
			defaultContentType: "application/octet-stream",
		};
	}

	if (responseValue instanceof ArrayBuffer) {
		return { bytes: Buffer.from(responseValue), defaultContentType: "application/octet-stream" };
	}

	if (!isRecord(responseValue)) return null;

	const serialized = serializedBodyCache.get(responseValue) ?? JSON.stringify(responseValue);

	return { bytes: Buffer.from(serialized), defaultContentType: "application/json; charset=utf-8" };
}

/**
 * Response Compression Middleware.
 * Compresses responses using the best available encoding (br > gzip > deflate).
 *
 * Skips responses that are:
 * - Already compressed (Content-Encoding set)
 * - Binary types (image/*, video/*, audio/*, application/octet-stream)
 * - Below minimum size threshold (1KB)
 */
export const compressionMiddleware = new Elysia({ name: "Compression" })
	.mapResponse(async ({ request, responseValue, set }): Promise<Response | undefined> => {
		if (!serverConfig.compression.enabled) return undefined;

		// Cheap guards first: every image, HLS segment and pre-serialized cached
		// JSON response is already a Response (or already encoded), so skip the
		// Accept-Encoding parse entirely for them.
		if (set.headers["content-encoding"] || responseValue instanceof Response) return undefined;

		const encoding = negotiateEncoding(request.headers.get("accept-encoding") ?? "");
		if (!encoding) return undefined;

		const setContentType = set.headers["content-type"];
		const body = responseBodyBytes(responseValue);
		if (!body || body.bytes.byteLength < serverConfig.compression.minSizeBytes) return undefined;

		const contentType = typeof setContentType === "string" && setContentType ? setContentType : body.defaultContentType;
		if (!shouldCompress(contentType, body.bytes.byteLength)) return undefined;

		const compressed = await compressBuffer(body.bytes, encoding);

		set.headers["content-encoding"] = encoding;
		set.headers["content-length"] = String(compressed.byteLength);
		set.headers["content-type"] = contentType;
		set.headers.vary = "Accept-Encoding";

		return new Response(compressed, {
			status: getResponseStatus(set),
			headers: headersFromRecord(set.headers),
		});
	})
	.as("global");
