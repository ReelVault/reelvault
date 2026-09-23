import { HttpClient, type HttpRequestSpec } from "./http-client";
import type { HeadersInput, QueryParams, ResourceConfig } from "./types";
import { serializeBody } from "./utils";
import { assertValidPath } from "./validation";

const TRAILING_SLASH_REGEX = /\/$/;

export abstract class BaseResource {
	protected readonly config: ResourceConfig;
	private readonly http: HttpClient;

	constructor(config: ResourceConfig, http?: HttpClient) {
		this.config = config;
		this.http = http ?? new HttpClient(config);
	}

	public setAccessToken(token: string | undefined): void {
		this.http.setAccessToken(token);
	}

	protected getBaseUrl(): string {
		const raw = typeof this.config.baseUrl === "function" ? this.config.baseUrl() : this.config.baseUrl;

		return raw.replace(TRAILING_SLASH_REGEX, "");
	}

	/**
	 * Validates the path. Errors are returned as a rejected promise, never
	 * synchronously, so the `Promise` contract holds for callers.
	 * Payload validation lives on the server — the client is a thin transport.
	 */
	private rejectOnInvalid(path: string, method: string): Error | undefined {
		try {
			assertValidPath(path, { method });
		} catch (error) {
			return error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown error");
		}

		return undefined;
	}

	/**
	 * Low-level HTTP request with full control (retry, dedup, cache, timeout).
	 * Returns the parsed response.
	 */
	protected request<T>(
		path: string,
		options: RequestInit & {
			query?: QueryParams | undefined;
			skipRetry?: boolean | undefined;
			skipDeduplication?: boolean | undefined;
			skipCache?: boolean | undefined;
			cacheTtlMs?: number | undefined;
		} = {},
	): Promise<T> {
		const { query, skipRetry, skipDeduplication, skipCache, cacheTtlMs, ...fetchOptions } = options;
		const method = fetchOptions.method ?? "GET";
		const error = this.rejectOnInvalid(path, method);
		if (error !== undefined) return Promise.reject(error);

		return this.http.request<T>({
			method,
			path,
			query,
			headers: fetchOptions.headers,
			body: fetchOptions.body ?? undefined,
			signal: fetchOptions.signal ?? undefined,
			skipRetry,
			skipDeduplication,
			skipCache,
			cacheTtlMs,
		});
	}

	protected _get<T>(
		path: string,
		options?: {
			query?: QueryParams | undefined;
			headers?: HeadersInput | undefined;
			signal?: AbortSignal | undefined;
			skipRetry?: boolean | undefined;
			skipCache?: boolean | undefined;
			cacheTtlMs?: number | undefined;
		},
	): Promise<T> {
		const method = "GET";
		const error = this.rejectOnInvalid(path, method);
		if (error !== undefined) return Promise.reject(error);

		return this.http.request<T>({
			method,
			path,
			query: options?.query,
			headers: options?.headers,
			signal: options?.signal,
			skipRetry: options?.skipRetry,
			skipCache: options?.skipCache,
			cacheTtlMs: options?.cacheTtlMs,
		});
	}

	protected _post<T>(
		path: string,
		options: {
			body?: unknown;
			query?: QueryParams | undefined;
			headers?: HeadersInput | undefined;
			signal?: AbortSignal | undefined;
			skipRetry?: boolean | undefined;
		} = {},
	): Promise<T> {
		const method = "POST";
		const error = this.rejectOnInvalid(path, method);
		if (error !== undefined) return Promise.reject(error);

		return this.http.request<T>({
			method,
			path,
			body: options.body !== undefined ? serializeBody(options.body) : undefined,
			query: options.query,
			headers: options.headers,
			signal: options.signal,
			skipRetry: options.skipRetry,
		});
	}

	protected _put<T>(
		path: string,
		options: {
			body?: unknown;
			query?: QueryParams | undefined;
			headers?: HeadersInput | undefined;
			signal?: AbortSignal | undefined;
			skipRetry?: boolean | undefined;
		} = {},
	): Promise<T> {
		const method = "PUT";
		const error = this.rejectOnInvalid(path, method);
		if (error !== undefined) return Promise.reject(error);

		return this.http.request<T>({
			method,
			path,
			body: options.body !== undefined ? serializeBody(options.body) : undefined,
			query: options.query,
			headers: options.headers,
			signal: options.signal,
			skipRetry: options.skipRetry,
		});
	}

	protected _patch<T>(
		path: string,
		options: {
			body?: unknown;
			query?: QueryParams | undefined;
			headers?: HeadersInput | undefined;
			signal?: AbortSignal | undefined;
			skipRetry?: boolean | undefined;
		} = {},
	): Promise<T> {
		const method = "PATCH";
		const error = this.rejectOnInvalid(path, method);
		if (error !== undefined) return Promise.reject(error);

		return this.http.request<T>({
			method,
			path,
			body: options.body !== undefined ? serializeBody(options.body) : undefined,
			query: options.query,
			headers: options.headers,
			signal: options.signal,
			skipRetry: options.skipRetry,
		});
	}

	protected _delete<T>(
		path: string,
		options?: {
			body?: unknown;
			query?: QueryParams | undefined;
			headers?: HeadersInput | undefined;
			signal?: AbortSignal | undefined;
			skipRetry?: boolean | undefined;
		},
	): Promise<T> {
		const method = "DELETE";
		const error = this.rejectOnInvalid(path, method);
		if (error !== undefined) return Promise.reject(error);

		return this.http.request<T>({
			method,
			path,
			body: options?.body !== undefined ? serializeBody(options.body) : undefined,
			query: options?.query,
			headers: options?.headers,
			signal: options?.signal,
			skipRetry: options?.skipRetry,
		});
	}

	/**
	 * Returns the raw `Response` (without parsing the body) — useful for
	 * streaming large files or reading response headers.
	 */
	protected _requestRaw(path: string, options?: Omit<HttpRequestSpec, "path">): Promise<Response> {
		const error = this.rejectOnInvalid(path, options?.method ?? "GET");
		if (error !== undefined) return Promise.reject(error);

		return this.http.requestRaw({ ...options, path });
	}
}
