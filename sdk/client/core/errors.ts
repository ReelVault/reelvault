/**
 * Structured error hierarchy for the ReelVault SDK client.
 *
 * Every error produced by the client carries enough context to be logged or
 * rendered without additional lookups: status, machine-readable code, request
 * id, URL, method and the raw response payload. `toJSON()` makes them safe to
 * pipe into structured loggers (pino, etc.).
 */

export interface ApiProblemDetails {
	message?: string | undefined;
	code?: string | undefined;
	statusCode?: number | undefined;
	params?: Record<string, string | number | boolean | null> | undefined;
	type?: string | undefined;
	title?: string | undefined;
	detail?: string | undefined;
	error?: string | undefined;
	errors?: unknown;
	[key: string]: unknown;
}

interface ReelVaultErrorOptions {
	method?: string | undefined;
	attempt?: number | undefined;
}

/**
 * True for HTTP statuses that are worth retrying: request timeouts, rate
 * limits and transient server errors.
 */
export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class ReelVaultError extends Error {
	public readonly status: number;
	public readonly statusText: string;
	public readonly data: unknown;
	public readonly url: string;
	public readonly requestId?: string | undefined;
	public readonly code?: string | undefined;
	/** Interpolation values for the frontend translation of `code`. */
	public readonly params?: Record<string, string | number | boolean | null> | undefined;
	public readonly method?: string | undefined;
	public readonly attempt?: number | undefined;

	constructor(status: number, statusText: string, data: unknown, url: string, requestId?: string, options: ReelVaultErrorOptions = {}) {
		const context = options.method ? ` (${options.method} ${url})` : "";
		super(`HTTP ${status}: ${getErrorMessage(statusText, data, status)}${context}`);
		this.name = "ReelVaultError";

		this.status = status;
		this.statusText = statusText;
		this.data = data;
		this.url = url;
		this.requestId = requestId;
		this.code = getErrorCode(data);
		this.params = getErrorParams(data);
		this.method = options.method;
		this.attempt = options.attempt;
	}

	/**
	 * Whether this error is safe to retry (rate limits and transient 5xx).
	 */
	get retryable(): boolean {
		return isRetryableStatus(this.status);
	}

	override toString(): string {
		const suffix = this.requestId ? ` [request-id: ${this.requestId}]` : "";

		return `${this.name}: ${this.message}${suffix}`;
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			message: this.message,
			status: this.status,
			statusText: this.statusText,
			code: this.code,
			params: this.params,
			requestId: this.requestId,
			url: this.url,
			method: this.method,
			attempt: this.attempt,
			data: this.data,
		};
	}
}

export class NetworkError extends Error {
	public readonly url: string;
	public readonly method?: string | undefined;

	constructor(message: string, url: string, cause?: Error, method?: string) {
		super(message, cause !== undefined ? { cause } : undefined);
		this.name = "NetworkError";
		this.url = url;
		this.method = method;
	}

	override toString(): string {
		return `${this.name}: ${this.message} (${this.url})`;
	}

	toJSON(): Record<string, unknown> {
		return { name: this.name, message: this.message, url: this.url, method: this.method };
	}
}

export interface ValidationFieldError {
	path: string;
	message: string;
	value: unknown;
}

/**
 * Raised by the client when a request payload fails runtime validation against
 * the shared TypeBox schema, before the request is sent. Mirrors the same
 * constraints the server enforces, so clients get immediate, structured
 * feedback without a round trip.
 */
export class ReelVaultValidationError extends Error {
	public readonly errors: ValidationFieldError[];
	public readonly method: string | undefined;
	public readonly url: string | undefined;

	constructor(errors: ValidationFieldError[], options: { method?: string | undefined; url?: string | undefined } = {}) {
		const summary = errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ");
		super(`Validation failed${summary ? `: ${summary}` : ""}`);
		this.name = "ReelVaultValidationError";
		this.errors = errors;
		this.method = options.method;
		this.url = options.url;
	}

	override toString(): string {
		const suffix = this.url ? ` (${this.method ?? "request"} ${this.url})` : "";

		return `${this.name}: ${this.message}${suffix}`;
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			message: this.message,
			errors: this.errors,
			method: this.method,
			url: this.url,
		};
	}
}

export class TimeoutError extends Error {
	public readonly url: string;
	public readonly timeout: number;

	constructor(url: string, timeout: number) {
		super(`Request timeout after ${timeout}ms`);
		this.name = "TimeoutError";
		this.url = url;
		this.timeout = timeout;
	}

	override toString(): string {
		return `${this.name}: ${this.message} (${this.url})`;
	}

	toJSON(): Record<string, unknown> {
		return { name: this.name, message: this.message, url: this.url, timeout: this.timeout };
	}
}

function getErrorMessage(statusText: string, data: unknown, status: number): string {
	if (isRecord(data)) {
		const message = data.message ?? data.detail ?? data.title ?? data.error;
		if (typeof message === "string" && message.length > 0) return message;

		if (Array.isArray(data.errors) && data.errors.length > 0) {
			const first: unknown = data.errors[0];
			if (isRecord(first) && typeof first.message === "string" && first.message.length > 0) return first.message;

			if (typeof first === "string") return first;
		}
	}

	return statusText || `Request failed with status ${status}`;
}

function getErrorCode(data: unknown): string | undefined {
	if (!isRecord(data)) return undefined;

	if (typeof data.code === "string") return data.code;

	if (typeof data.error === "string") return data.error;

	return undefined;
}

function getErrorParams(data: unknown): Record<string, string | number | boolean | null> | undefined {
	if (!(isRecord(data) && isRecord(data.params))) return undefined;

	const params: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(data.params)) {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) params[key] = value;
	}

	return Object.keys(params).length > 0 ? params : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
