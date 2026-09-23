import { describe, expect, test } from "bun:test";
import { KeysetCursor } from "./keyset-cursor";

describe("KeysetCursor", () => {
	test("round-trips a createdAt and id cursor", () => {
		const cursor = { createdAt: 1_725_000_000_000, id: "metadata-42" };
		expect(KeysetCursor.decode(KeysetCursor.encode(cursor))).toEqual(cursor);
	});

	test("rejects malformed cursors", () => {
		expect(() => KeysetCursor.decode("not-a-cursor")).toThrow("Invalid pagination cursor");
	});
});
