import { describe, expect, test } from "bun:test";
import { createValueCodecs } from "./value-codecs.utils";

describe("boolean value codec", () => {
	const codec = createValueCodecs().boolean();

	test.each([
		["true", true],
		["1", true],
		["false", false],
		["0", false],
	] as const)("parses %p as %p", (raw, expected) => {
		expect(codec.parse(raw)).toBe(expected);
	});

	test("rejects a value that is not a boolean with null", () => {
		expect(codec.parse("yes")).toBeNull();
	});
});
