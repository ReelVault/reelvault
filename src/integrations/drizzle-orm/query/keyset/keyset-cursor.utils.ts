import { and, eq, lt, or, type SQL, type SQLWrapper } from "drizzle-orm";
import { DomainError } from "@/utils/domain.errors";
import { safeParseJson } from "@/utils/json.utils";
import { isFiniteNumber, isNonEmptyString, isRecord } from "@/utils/type.utils";

export interface CreatedAtCursor {
	createdAt: number;
	id: string;
}

function isCreatedAtCursor(value: unknown): value is CreatedAtCursor {
	if (!isRecord(value)) return false;

	return isFiniteNumber(value.createdAt) && isNonEmptyString(value.id);
}

export function encodeCursor(cursor: CreatedAtCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(value: string): CreatedAtCursor {
	// base64url decoding never throws: malformed input becomes text that fails the JSON shape check below.
	const parsed = safeParseJson(Buffer.from(value, "base64url").toString("utf8"));
	if (!isCreatedAtCursor(parsed)) throw new DomainError("validation", "Invalid pagination cursor", { code: "validation.invalid_cursor" });

	return parsed;
}

/**
 * Decodes a cursor only when the query is in cursor mode — a cursor on any
 * other sort order is a client error, not a silently ignored parameter.
 */
export function decodeCursorFor(cursor: string | undefined, cursorMode: boolean, errorMessage: string): CreatedAtCursor | undefined {
	if (cursor && !cursorMode) throw new DomainError("validation", errorMessage, { code: "validation.cursor_not_supported" });

	return cursor && cursorMode ? decodeCursor(cursor) : undefined;
}

/** Keyset seek predicate for a `(date, id)` descending order: strictly older, or same date with a smaller id. */
export function keysetWhere(dateColumn: SQLWrapper, idColumn: SQLWrapper, cursor: CreatedAtCursor): SQL | undefined {
	const date = new Date(cursor.createdAt);

	return or(lt(dateColumn, date), and(eq(dateColumn, date), lt(idColumn, cursor.id)));
}
