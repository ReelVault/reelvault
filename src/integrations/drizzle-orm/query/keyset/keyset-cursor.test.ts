import { describe, expect, test } from "bun:test";
import { decodeCursor, decodeCursorFor, encodeCursor } from "./keyset-cursor.utils";

describe("KeysetCursor", () => {
	test("round-trips a createdAt and id cursor", () => {
		const cursor = { createdAt: 1_725_000_000_000, id: "metadata-42" };
		expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
	});

	test("rejects malformed cursors", () => {
		expect(() => decodeCursor("not-a-cursor")).toThrow(
			expect.objectContaining({ category: "validation", code: "validation.invalid_cursor" }),
		);
	});
});

describe("decodeCursorFor", () => {
	test("decodes a cursor in cursor mode", () => {
		const cursor = { createdAt: 1, id: "m-1" };
		expect(decodeCursorFor(encodeCursor(cursor), true, "cursor requires desc")).toEqual(cursor);
	});

	test("rejects a cursor outside cursor mode", () => {
		expect(() => decodeCursorFor("not-a-cursor", false, "cursor requires desc")).toThrow(
			expect.objectContaining({ category: "validation", code: "validation.cursor_not_supported" }),
		);
	});

	test("returns undefined when no cursor is supplied", () => {
		expect(decodeCursorFor(undefined, true, "cursor requires desc")).toBeUndefined();
		expect(decodeCursorFor(undefined, false, "cursor requires desc")).toBeUndefined();
	});
});
