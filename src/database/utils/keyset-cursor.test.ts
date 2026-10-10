import { describe, expect, test } from "bun:test";
import { decodeCursorFor, KeysetCursor } from "./keyset-cursor";

/** The error a call throws, so its code can be asserted. */
function thrownBy(call: () => unknown): unknown {
	try {
		call();
	} catch (error) {
		return error;
	}

	return undefined;
}

describe("KeysetCursor", () => {
	test("round-trips a createdAt and id cursor", () => {
		const cursor = { createdAt: 1_725_000_000_000, id: "metadata-42" };
		expect(KeysetCursor.decode(KeysetCursor.encode(cursor))).toEqual(cursor);
	});

	test("rejects malformed cursors", () => {
		expect(() => KeysetCursor.decode("not-a-cursor")).toThrow("Invalid pagination cursor");
	});

	test("a malformed cursor answers the invalid-cursor code", () => {
		expect(thrownBy(() => KeysetCursor.decode("not-a-cursor"))).toMatchObject({ code: "validation.invalid_cursor" });
	});

	test("a cursor on a sort order that does not page by cursor answers the cursor-not-supported code", () => {
		const cursor = KeysetCursor.encode({ createdAt: 1_725_000_000_000, id: "metadata-42" });

		expect(thrownBy(() => decodeCursorFor(cursor, false, "Sorting by title has no cursor"))).toMatchObject({
			code: "validation.cursor_not_supported",
		});
		expect(decodeCursorFor(cursor, true, "unused")).toEqual({ createdAt: 1_725_000_000_000, id: "metadata-42" });
	});
});

describe("decodeCursorFor", () => {
	test("decodes only in cursor mode", () => {
		const cursor = { createdAt: 1, id: "m-1" };
		expect(decodeCursorFor(KeysetCursor.encode(cursor), true, "cursor requires desc")).toEqual(cursor);
	});

	test("rejects a cursor outside cursor mode", () => {
		expect(() => decodeCursorFor("not-a-cursor", false, "cursor requires desc")).toThrow("cursor requires desc");
	});

	test("returns undefined when no cursor is supplied", () => {
		expect(decodeCursorFor(undefined, true, "cursor requires desc")).toBeUndefined();
		expect(decodeCursorFor(undefined, false, "cursor requires desc")).toBeUndefined();
	});
});
