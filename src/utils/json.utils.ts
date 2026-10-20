/**
 * JSON helpers. They live here rather than in `file.utils.ts` because they say
 * nothing about files: a stored payload, a queue row and a log line are all
 * JSON strings.
 */

/** Parses JSON, returning `null` for absent or malformed input. */
export function safeParseJson(value: string | null | undefined): unknown {
	if (!value) return null;

	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}
