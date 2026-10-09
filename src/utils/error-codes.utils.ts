import { DomainError } from "@/utils/errors";

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * The code a failure is recorded and reported with: a domain error keeps its own code, anything else gets
 * the fallback. The exception message itself is never stored or returned.
 */
export function errorCodeOf(error: unknown, fallback: string): string {
	return error instanceof DomainError ? error.code : fallback;
}

/**
 * A stored error value as a response code. Values written by this release are codes already; older rows
 * hold raw messages, which become the fallback so no exception text reaches a response.
 */
export function toErrorCode(stored: string | null | undefined, fallback: string): string | null {
	if (!stored) return null;

	return ERROR_CODE_PATTERN.test(stored) ? stored : fallback;
}
