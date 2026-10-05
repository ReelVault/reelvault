import { ReelVaultClient } from "@reelvault/sdk/client";

export type TestFetcher = (url: string, options: RequestInit) => Response | Promise<Response>;

export interface TestClientOptions {
	baseUrl?: string;
	enableRetry?: boolean;
	maxRetries?: number;
}

/**
 * `ReelVaultClient` wired to an in-memory fetcher. The default origin matches
 * the assertions in the SDK client tests — `buildUrl` always joins `/v1` paths
 * against the base URL's origin, so the path part of a configured baseUrl is
 * only relevant for the tests that assert on it.
 */
export function createTestClient(fetcher: TestFetcher, options: TestClientOptions = {}): ReelVaultClient {
	return new ReelVaultClient({
		baseUrl: options.baseUrl ?? "https://reelvault.test",
		fetcher: async (url, init) => await fetcher(url, init),
		...(options.enableRetry === undefined ? {} : { enableRetry: options.enableRetry }),
		...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
	});
}

/** JSON `Response` with the content-type every SDK client expects. */
export function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
