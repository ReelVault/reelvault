import { describe, expect, test } from "bun:test";
import { toIso639_1 } from "./language-codes.utils";

describe("language code normalization", () => {
	test.each([
		{ label: "the bibliographic Greek tag", input: "gre", expected: "el" },
		{ label: "the bibliographic Quechua tag", input: "que", expected: "qu" },
		{ label: "the bibliographic Serbian tag", input: "srp", expected: "sr" },
		{ label: "a common container tag", input: "pol", expected: "pl" },
	] as const)("$label maps to $expected", ({ input, expected }) => {
		expect(toIso639_1(input)).toBe(expected);
	});
});
