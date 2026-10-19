import { describe, expect, test } from "bun:test";
import { createValueCodecs } from "@/config/value-codecs.utils";
import { coerceBoolean, parseBooleanToken } from "./type.utils";

describe("parseBooleanToken", () => {
	test.each([
		["true", true],
		["TRUE", true],
		[" true ", true],
		["1", true],
		["false", false],
		["FALSE", false],
		["0", false],
	] as const)("reads %p as %p", (raw, expected) => {
		expect(parseBooleanToken(raw)).toBe(expected);
	});

	test.each(["", "yes", "no", "2", "on", "off"])("rejects %p as not a boolean", (raw) => {
		expect(parseBooleanToken(raw)).toBeUndefined();
	});
});

describe("coerceBoolean", () => {
	test.each([
		[true, true],
		[false, false],
		["true", true],
		["1", true],
		["false", false],
		["0", false],
		["", false],
		["yes", false],
		[undefined, false],
		[null, false],
		[1, true],
		[0, false],
	] as const)("coerces %p to %p", (value, expected) => {
		expect(coerceBoolean(value)).toBe(expected);
	});
});

describe("the settings codec and the query coercion", () => {
	const codec = createValueCodecs().boolean();

	test.each(["true", "1", "false", "0"] as const)("read %p the same way", (raw) => {
		expect(codec.parse(raw)).toBe(coerceBoolean(raw));
	});

	test("reject a value that is not a boolean", () => {
		expect(codec.parse("yes")).toBeNull();
	});
});
