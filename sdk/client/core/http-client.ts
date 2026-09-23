import { InFlightDeduper, TtlCache } from "./cache";
import { NetworkError, ReelVaultError, TimeoutError } from "./errors";
import { canRetry } from "./retry";
import { TokenManager } from "./token-manager";
import type { HeadersInput, QueryParams, ResourceConfig } from "./types";
import {
	appendQueryParams,
	buildUrl,
	createRequestKey,
	getAbortReason,
	getRetryDelay,
	hasHeader,
	hasNoStoreHeader,
	isEmptyResponse,
	isJsonContentType,
	isReadMethod,
	isTextContentType,
	looksLikeJson,
	normalizeHeaders,
	parseRetryAfter,
	shouldSetJsonContentType,
	sleep,
} from "./utils";

export interface HttpRequestSpec {
	method?: string | undefined;
	path: string;
	query?: QueryParams | undefined;
	headers?: HeadersInput | undefined;
	body?: BodyInit | undefined;
	signal?: AbortSignal | undefined;
	skipRetry?: boolean | undefined;
	skipDeduplication?: boolean | undefined;
	skipCache?: boolean | undefined;
	cacheTtlMs?: number | undefined;
	timeout?: number | undefined;
}

interface ResolvedSpec {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: BodyInit | undefined;
	signal?: AbortSignal | undefined;
	skipRetry?: boolean | undefined;
	cacheTtlMs?: number | undefined;
	timeout?: number | undefined;
}

/**
 * Response bodies are decoded by content type, but the caller owns the static
 * type `T`; the transport cannot verify that mapping at runtime, so decoded
 * values cross this single, documented boundary.
 */
function assertResponse<T>(_value: unknown, _expected?: Partial<T>): asserts _value is T {
	// Type-directed decode: see comment above.
}

/**
 * In-flight promises are tracked per request key, so a promise already tracked
 * for `key` is guaranteed to resolve to the same shape the current caller
 * expects.
 */
function assertPending<T>(_value: unknown, _expected?: Partial<T>): asserts _value is Promise<T> {
	// Type-directed dedup: see comment on assertResponse.
}

/**
 * The client's transport layer. Builds URLs, deduplicates and caches GETs,
 * handles timeout/abort, interceptors, automatic token refresh, retry with
 * Retry-After, and resilient response/error parsing.
 */
export class HttpClient {
	private readonly config: ResourceConfig;
	private readonly cache: TtlCache;
	private readonly inflight: InFlightDeduper;
	private readonly tokenManager: TokenManager;
	private readonly enableCache: boolean;
	private readonly cacheTtlMs: number;
	private readonly maxTokenRefreshAttempts: number;

	constructor(config: ResourceConfig) {
		this.config = config;
		this.cache = new TtlCache();
		this.inflight = new InFlightDeduper();
		this.tokenManager = new TokenManager();
		this.enableCache = config.enableCache ?? false;
		this.cacheTtlMs = config.cacheTtlMs ?? 5_000;
		this.maxTokenRefreshAttempts = config.maxTokenRefreshAttempts ?? 1;
	}

	getAccessToken(): string | undefined {
		return this.config.accessToken;
	}

	setAccessToken(token: string | undefined): void {
		this.config.accessToken = token;
	}

	clearCache(): void {
		this.cache.clear();
		this.inflight.clear();
	}

	/**
	 * Runs a request and returns the parsed response (JSON/text/blob).
	 * Concurrent GETs with the same key are deduplicated; GET results can be
	 * cached when `enableCache` is on.
	 */
	request<T>(options: HttpRequestSpec): Promise<T> {
		const spec = this.resolve(options);
		const read = isReadMethod(spec.method);
		const useDedup = read && !options.signal && !options.skipDeduplication;
		const useCache = useDedup && this.enableCache && !options.skipCache;

		const requestKey = createRequestKey(spec.method, spec.url, spec.headers, this.config.accessToken);

		if (useCache) {
			const cached = this.cache.get(requestKey);
			if (cached !== undefined) {
				assertResponse<T>(cached);

				return Promise.resolve(cached);
			}
		}

		if (useDedup) {
			const pending = this.inflight.get(requestKey);
			if (pending !== undefined) {
				assertPending<T>(pending);

				return pending;
			}
		}

		const promise = (async () => {
			try {
				const response = await this.run(spec, options.path);
				const data = await this.parseResponse<T>(response, spec.url);
				if (useCache && !hasNoStoreHeader(response)) {
					this.cache.set(requestKey, data, spec.cacheTtlMs ?? this.cacheTtlMs);
				}

				return data;
			} finally {
				if (useDedup) this.inflight.untrack(requestKey);
			}
		})();

		if (useDedup) {
			this.inflight.track(requestKey, promise);
		}

		return promise;
	}

	/**
	 * Runs a request and returns the raw `Response` (body not parsed) — for
	 * streaming files or reading headers.
	 */
	requestRaw(options: HttpRequestSpec): Promise<Response> {
		const spec = this.resolve(options);

		return this.run(spec, options.path);
	}

	private resolve(options: HttpRequestSpec): ResolvedSpec {
		const url = buildUrl(this.config.baseUrl, options.path);
		if (options.query) appendQueryParams(url, options.query);

		return {
			method: (options.method ?? "GET").toUpperCase(),
			url: url.toString(),
			headers: normalizeHeaders(options.headers),
			body: options.body,
			signal: options.signal,
			skipRetry: options.skipRetry,
			cacheTtlMs: options.cacheTtlMs,
			timeout: options.timeout,
		};
	}

	private async run(spec: ResolvedSpec, path: string): Promise<Response> {
		const maxRetries = spec.skipRetry ? 0 : this.config.maxRetries;
		const timeoutMs = spec.timeout ?? this.config.timeout;
		let refreshAttemptsLeft = this.maxTokenRefreshAttempts;

		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await this.sendOnce(spec, timeoutMs);
			} catch (error) {
				if (
					attempt < maxRetries &&
					canRetry(error, {
						enableRetry: this.config.enableRetry,
						retriesLeft: maxRetries - attempt,
						method: spec.method,
						headers: spec.headers,
						signal: spec.signal,
					})
				) {
					await sleep(getRetryDelay(attempt));
					continue;
				}

				throw error;
			}

			if (response.ok) {
				return response;
			}

			const error = await this.parseError(response, spec, attempt);

			// Automatic token refresh — only outside auth paths, behind a mutex for a
			// single shared refresh with a bounded number of attempts.
			if (
				response.status === 401 &&
				this.config.accessToken &&
				this.config.onTokenExpired &&
				refreshAttemptsLeft > 0 &&
				!isAuthEndpoint(path)
			) {
				const refreshed = await this.tryRefreshToken();
				if (refreshed !== undefined) {
					this.setAccessToken(refreshed);
					refreshAttemptsLeft--;
					continue;
				}

				throw error;
			}

			if (
				attempt < maxRetries &&
				canRetry(error, {
					enableRetry: this.config.enableRetry,
					retriesLeft: maxRetries - attempt,
					method: spec.method,
					headers: spec.headers,
					signal: spec.signal,
				})
			) {
				const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
				await sleep(getRetryDelay(attempt, retryAfterMs));
				continue;
			}

			throw error;
		}
	}

	private async sendOnce(spec: ResolvedSpec, timeoutMs: number): Promise<Response> {
		const requestHeaders: Record<string, string> = { ...this.config.defaultHeaders, ...spec.headers };

		if (this.config.accessToken) {
			requestHeaders.Authorization = `Bearer ${this.config.accessToken}`;
		}

		if (shouldSetJsonContentType(spec.body) && !hasHeader(requestHeaders, "content-type")) {
			requestHeaders["Content-Type"] = "application/json";
		}

		let url = spec.url;
		let options: RequestInit = { method: spec.method, headers: requestHeaders, body: spec.body ?? null, signal: spec.signal ?? null };

		for (const interceptor of this.config.requestInterceptors) {
			const result = await interceptor(url, options);
			url = result.url;
			options = result.options;
		}

		let response = await this.fetchWithTimeout(url, options, timeoutMs);

		for (const interceptor of this.config.responseInterceptors) {
			response = await interceptor(response);
		}

		return response;
	}

	private async fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
		const controller = new AbortController();
		const callerSignal = options.signal;
		// Wrapped in an object: the timer mutates it from a callback, which
		// control-flow analysis cannot track through a plain local flag.
		const timeoutState = { timedOut: false };
		const abortFromCaller = () => controller.abort(callerSignal?.reason);

		if (callerSignal?.aborted) throw getAbortReason(callerSignal);

		callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
		const timeoutId = setTimeout(() => {
			timeoutState.timedOut = true;
			controller.abort();
		}, timeoutMs);

		try {
			return await this.config.fetcher(url, {
				...options,
				signal: controller.signal,
				credentials: this.config.credentials,
			});
		} catch (error) {
			if (timeoutState.timedOut) throw new TimeoutError(url, timeoutMs);

			if (callerSignal?.aborted) throw getAbortReason(callerSignal);

			throw new NetworkError(
				"Network request failed",
				url,
				error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown error"),
				options.method,
			);
		} finally {
			clearTimeout(timeoutId);
			callerSignal?.removeEventListener("abort", abortFromCaller);
		}
	}

	private async parseResponse<T>(response: Response, url: string): Promise<T> {
		if (isEmptyResponse(response)) {
			const empty: unknown = undefined;
			assertResponse<T>(empty);

			return empty;
		}

		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		if (isJsonContentType(contentType)) {
			const content = await response.text();
			if (!content) {
				const empty: unknown = undefined;
				assertResponse<T>(empty);

				return empty;
			}

			try {
				const parsed: unknown = JSON.parse(content);
				assertResponse<T>(parsed);

				return parsed;
			} catch (cause) {
				throw new Error(`ReelVault: server returned invalid JSON from ${url}`, { cause });
			}
		}

		if (isTextContentType(contentType)) {
			const text = await response.text();
			assertResponse<T>(text);

			return text;
		}

		const blob = await response.blob();
		assertResponse<T>(blob);

		return blob;
	}

	private async parseError(response: Response, spec: ResolvedSpec, attempt: number): Promise<ReelVaultError> {
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		const text = await response.text();
		let data: unknown = null;

		if (text) {
			if (isJsonContentType(contentType) || looksLikeJson(text)) {
				try {
					data = JSON.parse(text);
				} catch {
					data = text;
				}
			} else {
				data = text;
			}
		}

		const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;

		return new ReelVaultError(response.status, response.statusText, data, spec.url, requestId, {
			method: spec.method,
			attempt,
		});
	}

	private async tryRefreshToken(): Promise<string | undefined> {
		const refresher = this.config.onTokenExpired;
		if (!refresher) return undefined;

		try {
			return await this.tokenManager.refresh(refresher);
		} catch {
			return undefined;
		}
	}
}

const AUTH_PATH_REGEX = /^\/auth(\/|$)/;

function isAuthEndpoint(path: string): boolean {
	return AUTH_PATH_REGEX.test(path);
}
