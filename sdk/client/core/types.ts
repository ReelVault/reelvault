export type QueryParams = object;

export type HeadersInput = HeadersInit | Record<string, string> | Map<string, string>;

export type Fetcher = (url: string, options: RequestInit) => Promise<Response>;

export type RequestInterceptor = (
	url: string,
	options: RequestInit,
) => Promise<{ url: string; options: RequestInit }> | { url: string; options: RequestInit };

export type ResponseInterceptor = (response: Response) => Promise<Response> | Response;

export interface ClientConfig {
	baseUrl: string | (() => string);
	/**
	 * Custom fetch implementation. Defaults to global fetch.
	 */
	fetcher?: Fetcher | undefined;
	/**
	 * Default headers for every request.
	 */
	headers?: HeadersInput | undefined;
	/**
	 * Access token added as a Bearer authorization header.
	 */
	accessToken?: string | undefined;
	/**
	 * Called after a 401 response to obtain a replacement access token.
	 */
	onTokenExpired?: (() => Promise<string> | string) | undefined;
	/**
	 * Request interceptors executed before each network request.
	 */
	requestInterceptors?: RequestInterceptor[] | undefined;
	/**
	 * Response interceptors executed after each network response.
	 */
	responseInterceptors?: ResponseInterceptor[] | undefined;
	/**
	 * Enable automatic retry for transient failures. Defaults to true.
	 */
	enableRetry?: boolean | undefined;
	/**
	 * Maximum retry count. Defaults to 3.
	 */
	maxRetries?: number | undefined;
	/**
	 * Per-request timeout in milliseconds. Defaults to 30000.
	 */
	timeout?: number | undefined;
	/**
	 * Fetch credentials mode. Use `include` for cross-origin cookie sessions.
	 */
	credentials?: RequestCredentials | undefined;
	/**
	 * Enable TTL caching of successful GET responses. Defaults to false.
	 * The in-flight deduplication of concurrent GETs is always active.
	 */
	enableCache?: boolean | undefined;
	/**
	 * Time-to-live for cached GET responses in milliseconds. Defaults to 5000.
	 */
	cacheTtlMs?: number | undefined;
	/**
	 * How many times a 401 response may trigger a token refresh for a single
	 * request. Defaults to 1.
	 */
	maxTokenRefreshAttempts?: number | undefined;
}

/**
 * Internal configuration shared by all resource clients.
 */
export interface ResourceConfig {
	baseUrl: string | (() => string);
	fetcher: Fetcher;
	defaultHeaders: Record<string, string>;
	accessToken?: string | undefined;
	onTokenExpired?: (() => Promise<string> | string) | undefined;
	requestInterceptors: RequestInterceptor[];
	responseInterceptors: ResponseInterceptor[];
	enableRetry: boolean;
	maxRetries: number;
	timeout: number;
	credentials: RequestCredentials;
	enableCache?: boolean | undefined;
	cacheTtlMs?: number | undefined;
	maxTokenRefreshAttempts?: number | undefined;
}
