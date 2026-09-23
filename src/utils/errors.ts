import { isRecord } from "./type.utils";

/**
 * Coarse error categories. They map 1:1 to HTTP status codes and are used as the
 * default `code` when a call site does not provide a granular one.
 */
export type DomainErrorCategory =
	| "validation"
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "conflict"
	| "timeout"
	| "too_many_requests"
	| "internal";

/** Interpolation values the frontend uses to render a translated message. */
export type DomainErrorParams = Record<string, string | number | boolean | null | undefined>;

interface DomainErrorOptions extends ErrorOptions {
	/**
	 * Granular, stable machine code (e.g. `"profile.pin_invalid"`). The frontend
	 * translates this; it must never be a human sentence. Defaults to the
	 * category (`"not_found"`, …).
	 */
	code?: string | undefined;
	/** Values interpolated into the frontend translation. */
	params?: DomainErrorParams | undefined;
	/** Extra structured context (never translated). */
	details?: unknown;
}

/**
 * Base class for all expected/handled failures.
 *
 * `message` is a developer-facing diagnostic kept for server logs only — it is
 * deliberately NOT part of the API response. Clients receive `code` + `params`
 * and translate locally.
 */
export abstract class DomainError extends Error {
	abstract readonly category: DomainErrorCategory;
	readonly code: string;
	readonly params?: DomainErrorParams | undefined;
	readonly details?: unknown;

	protected constructor(category: DomainErrorCategory, message: string, options?: DomainErrorOptions) {
		super(message, options);
		this.name = this.constructor.name;
		this.code = options?.code ?? category;
		this.params = options?.params;
		this.details = options?.details;
	}
}

export class ValidationError extends DomainError {
	readonly category = "validation" as const;

	constructor(message: string, options?: DomainErrorOptions) {
		super("validation", message, options);
	}
}

export class UnauthorizedError extends DomainError {
	readonly category = "unauthorized" as const;

	constructor(message: string, options?: DomainErrorOptions) {
		super("unauthorized", message, options);
	}
}

export class ForbiddenError extends DomainError {
	readonly category = "forbidden" as const;

	constructor(message: string, options?: DomainErrorOptions) {
		super("forbidden", message, options);
	}
}

export class NotFoundError extends DomainError {
	readonly category = "not_found" as const;

	constructor(message: string, options?: DomainErrorOptions) {
		super("not_found", message, options);
	}
}

export class ConflictError extends DomainError {
	readonly category = "conflict" as const;

	constructor(message: string, options?: DomainErrorOptions) {
		super("conflict", message, options);
	}
}

export class RequestTimeoutError extends DomainError {
	readonly category = "timeout" as const;

	constructor(message: string, options?: DomainErrorOptions) {
		super("timeout", message, options);
	}
}

export class TooManyRequestsError extends DomainError {
	readonly category = "too_many_requests" as const;

	constructor(message: string, options?: DomainErrorOptions) {
		super("too_many_requests", message, options);
	}
}

export class InternalError extends DomainError {
	readonly category = "internal" as const;

	constructor(message: string, options?: DomainErrorOptions) {
		super("internal", message, options);
	}
}

/** Type guard for Node.js `ENOENT` errors — replaces scattered `(error as { code?: string }).code === "ENOENT"` casts. */
export function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
	return isRecord(error) && error.code === "ENOENT";
}

/** Extracts a human-readable message from any thrown value (server logs only). */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		const cause = "cause" in error ? error.cause : undefined;
		if (cause instanceof Error && cause.message && !error.message.includes(cause.message)) {
			return `${error.message} (cause: ${cause.message})`;
		}

		return error.message;
	}

	return String(error);
}

/**
 * Standalone assertion for use outside BaseService (workers, utilities).
 * Throws NotFoundError when the value is null/undefined.
 */
export function assertFound<T>(value: T | null | undefined, entityType: string, entityId?: string): asserts value is T {
	if (value == null) {
		const message = entityId !== undefined ? `${entityType} not found: ${entityId}` : `${entityType} not found`;
		throw new NotFoundError(message, {
			code: "entity.not_found",
			...(entityId !== undefined ? { params: { entityType, entityId } } : {}),
		});
	}
}
