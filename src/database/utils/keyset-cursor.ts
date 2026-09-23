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
