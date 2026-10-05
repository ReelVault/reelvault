import { and, eq, lt, or, type SQL, type SQLWrapper } from "drizzle-orm";
import { ValidationError } from "@/utils/errors";
import { safeParseJson } from "@/utils/file.utils";
import { isFiniteNumber, isNonEmptyString, isRecord } from "@/utils/type.utils";

export interface CreatedAtCursor {
	createdAt: number;
	id: string;
}

const isCreatedAtCursor = (value: unknown): value is CreatedAtCursor => {
	if (!isRecord(value)) return false;

	return isFiniteNumber(value.createdAt) && isNonEmptyString(value.id);
};

export const KeysetCursor = {
	encode(cursor: CreatedAtCursor): string {
		return Buffer.from(JSON.stringify(cursor)).toString("base64url");
	},

	decode(value: string): CreatedAtCursor {
		let text: string;
		try {
			text = Buffer.from(value, "base64url").toString("utf8");
		} catch {
			throw new ValidationError("Invalid pagination cursor");
		}

		const parsed = safeParseJson(text);
		if (!isCreatedAtCursor(parsed)) throw new ValidationError("Invalid pagination cursor");

		return parsed;
	},
};

/**
 * Decodes a cursor only when the query is in cursor mode — a cursor on any
 * other sort order is a client error, not a silently ignored parameter.
 */
export function decodeCursorFor(cursor: string | undefined, cursorMode: boolean, errorMessage: string): CreatedAtCursor | undefined {
	if (cursor && !cursorMode) throw new ValidationError(errorMessage);

	return cursor && cursorMode ? KeysetCursor.decode(cursor) : undefined;
}

/** Keyset seek predicate for a `(date, id)` descending order: strictly older, or same date with a smaller id. */
export function keysetWhere(dateColumn: SQLWrapper, idColumn: SQLWrapper, cursor: CreatedAtCursor): SQL | undefined {
	const date = new Date(cursor.createdAt);

	return or(lt(dateColumn, date), and(eq(dateColumn, date), lt(idColumn, cursor.id)));
}
