import { Elysia } from "elysia";
import { serverConfig } from "@/server.config";
import { compressBuffer, negotiateEncoding } from "@/utils/compression.utils";
import { getResponseStatus } from "@/utils/http.utils";
import { isRecord, normalizeLower } from "@/utils/type.utils";
import { serializedBodyCache } from "./response-cache.middleware";

function matchesType(contentType: string, pattern: string): boolean {
	if (pattern.endsWith("/*")) return contentType.startsWith(pattern.slice(0, -2));

	return contentType === pattern;
}

const compressibleTypes = new Set(serverConfig.compression.types);
const excludedTypes = new Set(serverConfig.compression.excludeTypes);

function shouldCompress(contentType: string, size: number): boolean {
	if (size < serverConfig.compression.minSizeBytes) return false;

	const mimeType = normalizeLower(contentType.split(";")[0] ?? "");
	for (const t of excludedTypes) {
		if (matchesType(mimeType, t)) return false;
	}

	for (const t of compressibleTypes) {
		if (matchesType(mimeType, t)) return true;
	}

	return false;
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
/**
 * Normalizes a route response into a compressible Buffer, applying the minimum
 * size threshold and deriving the content type when the route did not set one.
 * Returns undefined when the response type is not compressible.
 */
function resolveCompressibleBody(
	responseValue: unknown,
	minSize: number,
	contentType: string,
): { body: Buffer; contentType: string } | undefined {
	if (typeof responseValue === "string") {
		if (responseValue.length < minSize) return undefined;

		return { body: Buffer.from(responseValue), contentType: contentType || "text/plain; charset=utf-8" };
	}

	if (responseValue instanceof Buffer) {
		if (responseValue.byteLength < minSize) return undefined;

		return { body: responseValue, contentType: contentType || "application/octet-stream" };
	}

	if (responseValue instanceof Uint8Array) {
		if (responseValue.byteLength < minSize) return undefined;

		return {
			body: Buffer.from(responseValue.buffer, responseValue.byteOffset, responseValue.byteLength),
			contentType: contentType || "application/octet-stream",
		};
	}

	if (responseValue instanceof ArrayBuffer) {
		if (responseValue.byteLength < minSize) return undefined;

		return { body: Buffer.from(responseValue), contentType: contentType || "application/octet-stream" };
	}

	if (!isRecord(responseValue)) return undefined;

	const preSerialized = serializedBodyCache.get(responseValue);
	const serialized = preSerialized ?? JSON.stringify(responseValue);
	if (serialized.length < minSize) return undefined;

	return { body: Buffer.from(serialized), contentType: contentType || "application/json; charset=utf-8" };
}

export const compressionMiddleware = new Elysia({ name: "Compression" })
	.mapResponse(async ({ request, responseValue, set }): Promise<Response | undefined> => {
		if (!serverConfig.compression.enabled) return undefined;

		const encoding = negotiateEncoding(request.headers.get("accept-encoding") ?? "");
		if (!encoding) return undefined;

		if (set.headers["content-encoding"] || responseValue instanceof Response) return undefined;

		const minSize = serverConfig.compression.minSizeBytes;
		const setContentType = set.headers["content-type"];
		const contentType = typeof setContentType === "string" ? setContentType : "";
		const bodyBytes = resolveCompressibleBody(responseValue, minSize, contentType);
		if (!bodyBytes) return undefined;

		if (!shouldCompress(bodyBytes.contentType, bodyBytes.body.byteLength)) return undefined;

		const compressed = await compressBuffer(bodyBytes.body, encoding);

		set.headers["content-encoding"] = encoding;
		set.headers["content-length"] = String(compressed.byteLength);
		set.headers["content-type"] = bodyBytes.contentType;
		set.headers.vary = "Accept-Encoding";

		const headers = new Headers();
		for (const [key, value] of Object.entries(set.headers)) {
			if (typeof value === "string") {
				headers.set(key, value);
			}
		}

		return new Response(Uint8Array.from(compressed), {
			status: getResponseStatus(set),
			headers,
		});
	})
	.as("global");
