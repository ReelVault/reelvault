import type { HeadersInput, QueryParams } from "./types";

export const sleep = (ms: number) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/** True when `value` is a finite number (not NaN, not Infinity). */
export function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Normalizes headers to Record<string, string>.
 */
export function normalizeHeaders(headers?: HeadersInput): Record<string, string> {
	if (!headers) return {};

	const result: Record<string, string> = {};

	if (headers instanceof Headers) {
		headers.forEach((value, key) => {
			result[key] = value;
		});
	} else if (headers instanceof Map) {
		headers.forEach((value, key) => {
			result[key] = value;
		});
	} else if (Array.isArray(headers)) {
		headers.forEach(([key, value]) => {
			result[key] = value;
		});
	} else {
		Object.assign(result, headers);
	}

	return result;
}

/**
 * Case-insensitive header lookup.
 */
export function hasHeader(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();

	return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

const TRAILING_SLASH_REGEX = /\/$/;

/**
 * Builds the final versioned API URL from the base address and the resource path.
 */
export function buildUrl(baseUrl: string | (() => string), path: string): URL {
	const base = typeof baseUrl === "function" ? baseUrl() : baseUrl;

	return new URL(`/v1${path}`, base.replace(TRAILING_SLASH_REGEX, ""));
}

/**
 * Serializes query params: arrays become repeated keys, null/undefined are skipped.
 */
export function appendQueryParams(url: URL, query: QueryParams): void {
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;

		if (Array.isArray(value)) {
			for (const item of value) url.searchParams.append(key, String(item));
		} else {
			url.searchParams.set(key, String(value));
		}
	}
}

/**
 * HTTP methods that are idempotent and safe to retry.
 */
export function isIdempotentMethod(method: string): boolean {
	return ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].includes(method.toUpperCase());
}

/**
 * GET-like methods — the only ones eligible for dedup and caching.
 */
export function isReadMethod(method: string): boolean {
	return ["GET", "HEAD"].includes(method.toUpperCase());
}

/**
 * Dedup/cache key. Deliberately excludes the body — dedup and cache apply
 * only to GET requests, which carry no body.
 */
export function createRequestKey(method: string, url: string, headers: Record<string, string>, accessToken: string | undefined): string {
	const headerKey = JSON.stringify(sortObject(headers));

	return `${method}:${url}:${accessToken ?? ""}:${headerKey}`;
}

/**
 * Delay before the next attempt. Honors the `Retry-After` header; otherwise
 * uses exponential backoff with a low starting base (200ms) and
 * ±20% jitter.
 */
export function getRetryDelay(attempt: number, retryAfterMs?: number): number {
	if (retryAfterMs !== undefined && retryAfterMs >= 0) {
		return Math.min(retryAfterMs, 30_000) + jitter(250);
	}

	const baseDelay = 200;
	const maxDelay = 5_000;
	const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);

	return delay + jitter(delay * 0.2);
}

/**
 * Parses the `Retry-After` header (seconds or an HTTP date) into milliseconds.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
	if (!value) return undefined;

	const seconds = Number(value);
	if (isFiniteNumber(seconds)) return Math.max(0, seconds) * 1000;

	const date = new Date(value);
	if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());

	return undefined;
}

/**
 * Whether a response must not be cached (Cache-Control: no-store/private).
 */
export function hasNoStoreHeader(response: Response): boolean {
	const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";

	return cacheControl.includes("no-store") || cacheControl.includes("private");
}

/**
 * A bodyless response (204/205, null body, or content-length 0).
 */
export function isEmptyResponse(response: Response): boolean {
	return response.status === 204 || response.status === 205 || response.body === null || response.headers.get("content-length") === "0";
}

export function isJsonContentType(contentType: string): boolean {
	return contentType.includes("json");
}

export function isTextContentType(contentType: string): boolean {
	return contentType.startsWith("text/") || contentType.includes("xml");
}

/**
 * Heuristic — parses a JSON body even when the content-type is wrong.
 */
export function looksLikeJson(text: string): boolean {
	const trimmed = text.trim();

	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function getAbortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Request aborted", "AbortError");
}

/**
 * Serializes the request body: objects → JSON, streams/binary → unchanged.
 */
export function serializeBody(body: unknown): BodyInit {
	if (
		body instanceof FormData ||
		body instanceof Blob ||
		body instanceof URLSearchParams ||
		typeof body === "string" ||
		body instanceof ArrayBuffer
	) {
		return body;
	}

	return JSON.stringify(body);
}

export function shouldSetJsonContentType(body: BodyInit | null | undefined): boolean {
	return (
		body !== undefined &&
		body !== null &&
		!(body instanceof FormData) &&
		!(body instanceof Blob) &&
		!(body instanceof URLSearchParams) &&
		!(body instanceof ArrayBuffer)
	);
}

function sortObject(record: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of Object.keys(record).toSorted()) {
		const value = record[key];
		if (value !== undefined) result[key] = value;
	}

	return result;
}

function jitter(max: number): number {
	return max * (Math.random() * 2 - 1);
}
