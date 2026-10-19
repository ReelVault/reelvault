import { trimAndFilter, unique } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { MemoryCache } from "@/utils/memory.cache";

export function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bounded cache for URL origin parsing — avoids repeated `new URL()` on every request. */
const parsedUrlCache = new MemoryCache<URL>({ ttlMs: -1, maxSize: 128, name: "parsed-url" });

export function parseOriginUrl(origin: string): URL | undefined {
	const cached = parsedUrlCache.get(origin);
	if (cached !== null) return cached;

	try {
		const url = new URL(origin);
		parsedUrlCache.set(origin, url);

		return url;
	} catch {
		return undefined;
	}
}

/**
 * Shared URL / HTTP utilities used across middleware and integrations.
 */

/** Extract the numeric status from Elysia's `set.status`, defaulting to `fallback`. */
export function getResponseStatus(set: { status?: number | string }, fallback = 200): number {
	return typeof set.status === "number" ? set.status : fallback;
}

/**
 * RFC 9110 If-None-Match evaluation: a comma-separated list of validators
 * matches when any candidate equals the ETag or its weak form `W/` + ETag.
 */
export function matchesIfNoneMatch(ifNoneMatch: string | null | undefined, etag: string): boolean {
	if (!ifNoneMatch) return false;

	// Fast path: a single, whitespace-free strong validator (the common case)
	// needs no split. Lists and weak validators use the matcher below.
	if (!(ifNoneMatch.includes(",") || ifNoneMatch.startsWith("W/")) && ifNoneMatch === ifNoneMatch.trim()) {
		return ifNoneMatch === "*" || ifNoneMatch === etag;
	}

	return ifNoneMatch.split(",").some((candidate) => {
		const value = candidate.trim();

		// RFC 9110: `*` matches any existing representation.
		return value === "*" || value === etag || value === `W/${etag}`;
	});
}

/**
 * Extracts the pathname from a full URL string without constructing a URL
 * object — avoids allocations on the hot request path.
 *
 * @example
 * getPathname("http://localhost:3000/v1/health?foo=bar") // "/v1/health"
 */
export function getPathname(url: string): string {
	const start = url.indexOf("/", 8);
	if (start === -1) return "/";

	const end = url.indexOf("?", start);

	return end === -1 ? url.slice(start) : url.slice(start, end);
}

/**
 * Extracts pathname + query string from a full URL string without constructing
 * a URL object — avoids allocations on the hot request path.
 *
 * @example
 * pathWithQuery("http://localhost:3000/v1/health?foo=bar") // "/v1/health?foo=bar"
 */
export function pathWithQuery(url: string): string {
	const start = url.indexOf("/", url.indexOf("//") + 2);

	return start === -1 ? url : url.slice(start);
}

/**
 * Normalizes a raw origin/URL string (with or without scheme) to a `URL`,
 * defaulting to `http:` when no scheme is given.
 *
 * @throws {Error} When the resulting URL uses an unsupported protocol.
 */
export function normalizeHttpUrl(value: string): URL {
	const url = new URL(value.includes("://") ? value : `http://${value}`);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new DomainError("validation", `URL must use HTTP or HTTPS, got: ${url.protocol}`, { code: "http.invalid_protocol" });
	}

	return url;
}

/**
 * Parses a comma-separated list or array of origins/patterns into a clean array.
 */
export function parseAllowedOrigins(value?: string | string[]): string[] {
	if (!value) return [];

	const rawList = Array.isArray(value) ? value : value.split(",");

	const origins = trimAndFilter(rawList);

	return unique(origins);
}

/** Credential segments every request-key builder composes (dedup, response cache). */
export interface RequestCredentials {
	authorization: string;
	cookie: string;
	/** Raw `x-profile-id` header; the resolved session profile is a separate input. */
	headerProfileId: string;
	apiKey: string;
}

/** Reads the credential headers request keys are scoped by; missing headers become empty segments. */
export function readRequestCredentials(request: Request): RequestCredentials {
	return {
		authorization: request.headers.get("authorization") ?? "",
		cookie: request.headers.get("cookie") ?? "",
		headerProfileId: request.headers.get("x-profile-id") ?? "",
		apiKey: request.headers.get("x-api-key") ?? "",
	};
}
