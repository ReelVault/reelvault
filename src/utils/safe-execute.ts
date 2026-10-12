import type { Logger } from "@reelvault/sdk";
import { WorkerCancellationError } from "@/workers/utils/worker-cancellation";
import { DomainError } from "./errors";

type ErrorFactory = Error | ((cause?: unknown) => Error);

interface SafeExecuteOptions {
	/** Custom error message to use when creating the default InternalError. */
	errorMessage?: string | undefined;
	/** Custom Error instance or factory function `(cause) => Error` to throw when an unhandled error occurs. */
	customThrow?: ErrorFactory | undefined;
	/** Optional additional context/metadata to include in log messages. */
	logContext?: Record<string, unknown> | undefined;
}

/** The service a `runSafely` call reports for: its name in messages and its logger. */
export interface SafeExecuteContext {
	readonly serviceName: string;
	readonly logger: Logger;
}

function elapsedMs(startTime: number): number {
	return Math.round((performance.now() - startTime) * 100) / 100;
}

/**
 * Runs `fn` and logs its outcome. Expected `DomainError`s and cancellations pass through;
 * anything else is wrapped as an `internal` DomainError (or `customThrow`).
 * A string third argument is shorthand for `{ errorMessage }`.
 */
export async function runSafely<T>(
	service: SafeExecuteContext,
	operation: string,
	fn: () => Promise<T> | T,
	options?: string | SafeExecuteOptions,
): Promise<T> {
	const startTime = performance.now();
	const opts: SafeExecuteOptions = typeof options === "string" ? { errorMessage: options } : (options ?? {});

	try {
		const result = await fn();
		service.logger.debug("Operation completed", {
			operation,
			durationMs: elapsedMs(startTime),
			...opts.logContext,
		});

		return result;
	} catch (error) {
		// Cancellation (superseded scan, session teardown) is expected flow, not
		// a failure — warn and propagate without the error-level noise.
		if (error instanceof WorkerCancellationError) {
			service.logger.warn(`Operation ${operation} cancelled`, {
				operation,
				durationMs: elapsedMs(startTime),
				...opts.logContext,
			});
			throw error;
		}

		service.logger.error(`Operation ${operation} failed`, error, {
			operation,
			durationMs: elapsedMs(startTime),
			...opts.logContext,
		});

		if (error instanceof DomainError) {
			throw error;
		}

		if (opts.customThrow) {
			const errorToThrow = typeof opts.customThrow === "function" ? opts.customThrow(error) : opts.customThrow;
			if (!("cause" in errorToThrow && errorToThrow.cause)) {
				Object.defineProperty(errorToThrow, "cause", {
					value: error,
					configurable: true,
					writable: true,
					enumerable: false,
				});
			}

			throw errorToThrow;
		}

		const message = opts.errorMessage
			? `${service.serviceName}.${operation} ${opts.errorMessage}`
			: `${service.serviceName}.${operation} failed`;
		throw new DomainError("internal", message, { cause: error });
	}
}
