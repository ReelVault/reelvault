import { isNullish, isRecord } from "@/utils/type.utils";

const SENSITIVE_LOG_KEY = /(authorization|cookie|password|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|storage[-_]?key)/i;

// Redaction only rewrites `Bearer <token>` and `kw=<value>` forms. The keyword prefilter is
// case-insensitive so case variants ("PASSWORD=x", "BEARER x") are redacted too; benign
// strings that merely contain the words (e.g. "keyboard") still skip the deep clone because
// the string predicate below requires an actual credential assignment.
const SENSITIVE_KEYWORD_RE = /Bearer|token|password|secret|key/i;
const SENSITIVE_STRING_RE = /Bearer\s+[^\s]+|(?:password|token|secret|api[-_]?key)=[^&\s]+/i;

const BEARER_REDACT = /(Bearer\s+)[^\s]+/gi;
const SECRET_REDACT = /((?:password|token|secret|api[-_]?key)=)[^&\s]+/gi;

const MAX_SANITIZE_DEPTH = 8;

function isSensitiveKey(key: string | undefined): boolean {
	return key !== undefined && key !== "" && SENSITIVE_LOG_KEY.test(key);
}

/** True only for strings the redaction patterns actually rewrite — benign values like "keyboard" no longer force a clone. */
function isSensitiveString(value: string): boolean {
	return SENSITIVE_KEYWORD_RE.test(value) && SENSITIVE_STRING_RE.test(value);
}

export function sanitizeLogValue<T>(value: T, key?: string): T;

export function sanitizeLogValue(value: unknown, key?: string): unknown {
	if (!needsSanitization(value, key, null, 0)) {
		return value;
	}

	return sanitizeLogValueInner(value, key, new WeakSet(), 0);
}

function needsSanitization(value: unknown, key: string | undefined, seen: WeakSet<object> | null, depth: number): boolean {
	if (isSensitiveKey(key)) return true;

	if (isNullish(value)) return false;

	if (typeof value === "number" || typeof value === "boolean" || typeof value === "symbol" || typeof value === "bigint") return false;

	if (value instanceof Error) return true;

	if (typeof value === "string") {
		return isSensitiveString(value);
	}

	if (depth >= MAX_SANITIZE_DEPTH) return false;

	if (Array.isArray(value)) return arrayNeedsSanitization(value, seen, depth);

	if (isRecord(value)) return recordNeedsSanitization(value, seen, depth);

	return false;
}

/** True when any item of the array needs sanitizing. */
function arrayNeedsSanitization(value: readonly unknown[], seen: WeakSet<object> | null, depth: number): boolean {
	const seenSet = seen ?? new WeakSet<object>();
	if (seenSet.has(value)) return false;

	seenSet.add(value);
	for (const item of value) {
		if (needsSanitization(item, undefined, seenSet, depth + 1)) {
			seenSet.delete(value);

			return true;
		}
	}

	seenSet.delete(value);

	return false;
}

/** True when any value of the record needs sanitizing. */
function recordNeedsSanitization(value: Record<string, unknown>, seen: WeakSet<object> | null, depth: number): boolean {
	const seenSet = seen ?? new WeakSet<object>();
	if (seenSet.has(value)) return false;

	seenSet.add(value);

	for (const entryKey of Object.keys(value)) {
		const entryValue: unknown = value[entryKey];
		if (needsSanitization(entryValue, entryKey, seenSet, depth + 1)) {
			seenSet.delete(value);

			return true;
		}
	}

	seenSet.delete(value);

	return false;
}

function sanitizeLogValueInner(value: unknown, key: string | undefined, seen: WeakSet<object>, depth: number): unknown {
	if (isSensitiveKey(key)) return "[REDACTED]";

	if (isNullish(value)) return value;

	if (typeof value === "number" || typeof value === "boolean" || typeof value === "symbol" || typeof value === "bigint") return value;

	if (value instanceof Error) {
		// The cause chain carries the actionable detail (e.g. the raw SQLite
		// message behind a wrapped DrizzleQueryError) — without it, logged
		// failures stop at "Failed query" and are undiagnosable.
		const cause = "cause" in value ? (value as { cause?: unknown }).cause : undefined;

		return {
			name: value.name,
			message: redactSensitiveText(value.message),
			stack: value.stack ? redactSensitiveText(value.stack) : undefined,
			...(cause !== undefined && { cause: sanitizeLogValueInner(cause, "cause", seen, depth + 1) }),
		};
	}

	if (typeof value === "string") {
		return redactSensitiveText(value);
	}

	if (depth >= MAX_SANITIZE_DEPTH) return "[MaxDepth]";

	if (Array.isArray(value)) {
		if (seen.has(value)) return "[Circular]";

		seen.add(value);
		const result = value.map((item) => sanitizeLogValueInner(item, undefined, seen, depth + 1));
		seen.delete(value);

		return result;
	}

	if (isRecord(value)) {
		if (seen.has(value)) return "[Circular]";

		seen.add(value);
		const result: Record<string, unknown> = {};
		for (const entryKey of Object.keys(value)) {
			const entryValue: unknown = value[entryKey];
			result[entryKey] = sanitizeLogValueInner(entryValue, entryKey, seen, depth + 1);
		}

		seen.delete(value);

		return result;
	}

	return value;
}

function redactSensitiveText(value: string): string {
	if (!isSensitiveString(value)) {
		return value;
	}

	return value.replaceAll(BEARER_REDACT, "$1[REDACTED]").replaceAll(SECRET_REDACT, "$1[REDACTED]");
}
