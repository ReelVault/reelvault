import { isRetryableStatus, NetworkError, ReelVaultError, TimeoutError } from "./errors";
import type { HeadersInput } from "./types";
import { hasHeader, isIdempotentMethod, normalizeHeaders } from "./utils";

/**
 * Whether an error qualifies for a retry.
 */
export function isRetryableError(error: unknown): boolean {
	if (error instanceof ReelVaultError) return isRetryableStatus(error.status);

	if (error instanceof NetworkError || error instanceof TimeoutError) return true;

	return false;
}

export interface RetryDecision {
	enableRetry: boolean;
	retriesLeft: number;
	method: string;
	headers?: HeadersInput | undefined;
	signal?: AbortSignal | undefined;
}

/**
 * Full retry decision: feature flag, attempts left, method idempotency
 * (or an idempotency-key header) and whether the caller aborted the request.
 */
export function canRetry(error: unknown, options: RetryDecision): boolean {
	if (!options.enableRetry || options.retriesLeft <= 0) return false;

	if (options.signal?.aborted) return false;

	if (!isRetryableError(error)) return false;

	return isIdempotentMethod(options.method) || hasHeader(normalizeHeaders(options.headers), "idempotency-key");
}
