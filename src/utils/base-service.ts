import type { Logger } from "@reelvault/sdk";
import { WorkerCancellationError } from "@/workers/utils/worker-cancellation";
import { DomainError, InternalError, NotFoundError, UnauthorizedError } from "./errors";
import { createLogger } from "./logger";

type ErrorFactory = Error | ((cause?: unknown) => Error);

interface SafeExecuteOptions {
	/** Custom error message to use when creating the default InternalError. */
	errorMessage?: string | undefined;
	/** Custom Error instance or factory function `(cause) => Error` to throw when an unhandled error occurs. */
	customThrow?: ErrorFactory | undefined;
	/** Optional additional context/metadata to include in log messages. */
	logContext?: Record<string, unknown> | undefined;
}

export class BaseService {
	readonly serviceName: string;
	readonly logger: Logger;

	constructor(name: string, logger?: Logger) {
		this.serviceName = name;
		this.logger = logger ?? createLogger(name);
	}

	private throwNotFound(entityType: string, entityId?: string, customThrow?: ErrorFactory): never {
		const message = entityId !== undefined ? `${entityType} not found: ${entityId}` : `${entityType} not found`;
		if (customThrow) {
			throw typeof customThrow === "function" ? customThrow() : customThrow;
		}

		// Granular code + params so API clients can translate without string matching.
		throw new NotFoundError(message, {
			code: "entity.not_found",
			...(entityId !== undefined ? { params: { entityType, entityId } } : {}),
		});
	}

	assertExists<T>(value: T | null | undefined, entityType: string, entityId?: string, customThrow?: ErrorFactory): asserts value is T {
		if (value == null) {
			this.throwNotFound(entityType, entityId, customThrow);
		}
	}

	assertFound(condition: boolean, entityType: string, entityId?: string, customThrow?: ErrorFactory): asserts condition {
		if (!condition) {
			this.throwNotFound(entityType, entityId, customThrow);
		}
	}

	assertProfileId(profileId: string | undefined): asserts profileId is string {
		if (!profileId) throw new UnauthorizedError("Active profile required", { code: "auth.profile_required" });
	}

	assertUserId(userId: string | undefined): asserts userId is string {
		if (!userId) throw new UnauthorizedError("Active user required", { code: "auth.user_required" });
	}

	safeExecute<T>(operation: string, fn: () => Promise<T> | T, errorMessage?: string): Promise<T>;
	safeExecute<T>(operation: string, fn: () => Promise<T> | T, options?: SafeExecuteOptions): Promise<T>;

	async safeExecute<T>(operation: string, fn: () => Promise<T> | T, options?: string | SafeExecuteOptions): Promise<T> {
		const startTime = performance.now();
		const opts: SafeExecuteOptions = typeof options === "string" ? { errorMessage: options } : (options ?? {});

		try {
			const result = await fn();
			this.logger.debug("Operation completed", {
				operation,
				durationMs: this.elapsedMs(startTime),
				...opts.logContext,
			});

			return result;
		} catch (error) {
			// Cancellation (superseded scan, session teardown) is expected flow, not
			// a failure — warn and propagate without the error-level noise.
			if (error instanceof WorkerCancellationError) {
				this.logger.warn(`Operation ${operation} cancelled`, {
					operation,
					durationMs: this.elapsedMs(startTime),
					...opts.logContext,
				});
				throw error;
			}

			this.logger.error(`Operation ${operation} failed`, error, {
				operation,
				durationMs: this.elapsedMs(startTime),
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
				? `${this.serviceName}.${operation} ${opts.errorMessage}`
				: `${this.serviceName}.${operation} failed`;
			throw new InternalError(message, { cause: error });
		}
	}

	private elapsedMs(startTime: number): number {
		return Math.round((performance.now() - startTime) * 100) / 100;
	}
}
