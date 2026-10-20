import { isNullish, isRecord } from "./type.utils";

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
 * The one expected/handled failure type. `category` picks the HTTP status and
 * `code` is the stable machine code clients translate: call sites write
 * `new DomainError("not_found", message, { code })`.
 *
 * `message` is a developer-facing diagnostic kept for server logs only — it is
 * deliberately NOT part of the API response. Clients receive `code` + `params`
 * and translate locally.
 */
export class DomainError extends Error {
	readonly category: DomainErrorCategory;
	readonly code: string;
	readonly params?: DomainErrorParams | undefined;
	readonly details?: unknown;

	constructor(category: DomainErrorCategory, message: string, options?: DomainErrorOptions) {
		super(message, options);
		this.name = "DomainError";
		this.category = category;
		this.code = options?.code ?? category;
		this.params = options?.params;
		this.details = options?.details;
	}
}

/** The POSIX error code of a thrown filesystem error ("ENOENT", "EACCES", …), or undefined. */
export function fsErrorCode(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	const code = error.code;

	return typeof code === "string" ? code : undefined;
}

/** Type guard for Node.js `ENOENT` errors — replaces scattered `(error as { code?: string }).code === "ENOENT"` casts. */
export function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
	return fsErrorCode(error) === "ENOENT";
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

/** Params with undefined values dropped, as the API envelope and the SDK types expect; undefined when none are left. */
export function definedParams(params: DomainErrorParams | undefined): Record<string, string | number | boolean | null> | undefined {
	if (!params) return undefined;

	const defined: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) defined[key] = value;
	}

	return Object.keys(defined).length > 0 ? defined : undefined;
}

/** Canonical not-found error carrying the translatable code + params for an entity. */
export function notFoundError(entityType: string, entityId?: string): DomainError {
	const message = entityId === undefined ? `${entityType} not found` : `${entityType} not found: ${entityId}`;

	return new DomainError("not_found", message, {
		code: "entity.not_found",
		...(entityId === undefined ? {} : { params: { entityType, entityId } }),
	});
}

type ErrorFactory = Error | ((cause?: unknown) => Error);

/**
 * Throws a `not_found` DomainError when the value is null/undefined, or `customThrow`
 * (an instance, or a factory called with no arguments) when one is given.
 */
/**
 * Not-found guard for records. It only rejects `null`/`undefined`: a boolean
 * `isExists()` result of `false` passes, so existence checks must use
 * {@link assertExists} instead.
 */
export function assertFound<T>(
	value: T | null | undefined,
	entityType: string,
	entityId?: string,
	customThrow?: ErrorFactory,
): asserts value is T {
	if (!isNullish(value)) return;
	if (customThrow) throw typeof customThrow === "function" ? customThrow() : customThrow;

	throw notFoundError(entityType, entityId);
}

/**
 * Not-found guard for existence probes. `false` from `isExists()` must never
 * reach `assertFound` — this is the boolean twin.
 */
export function assertExists(condition: boolean, entityType: string, entityId?: string, customThrow?: ErrorFactory): asserts condition {
	if (condition) return;
	if (customThrow) throw typeof customThrow === "function" ? customThrow() : customThrow;

	throw notFoundError(entityType, entityId);
}

export function assertProfileId(profileId: string | undefined): asserts profileId is string {
	if (!profileId) throw new DomainError("unauthorized", "Active profile required", { code: "auth.profile_required" });
}

export function assertUserId(userId: string | undefined): asserts userId is string {
	if (!userId) throw new DomainError("unauthorized", "Active user required", { code: "auth.user_required" });
}

/** Guards a dependency that must always be present — its absence is a caller bug (500), not a client-facing not-found (404). */
export function assertPresent<T>(value: T | null | undefined, message: string): asserts value is T {
	if (isNullish(value)) throw new DomainError("internal", message);
}

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

export function toDomainError(error: unknown, fallbackMessage: string): DomainError {
	if (error instanceof DomainError) return error;

	const message = error instanceof Error && error.message ? error.message : fallbackMessage;

	return new DomainError("internal", message, { cause: error });
}

/** Wraps an async function so any thrown error is converted to a `DomainError`. */
export async function withDomainError<T>(label: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toDomainError(error, label);
	}
}
