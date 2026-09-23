import { describe, expect, test } from "bun:test";
import { parseColonSeparatedSeconds } from "./time.utils";

describe("parseColonSeparatedSeconds", () => {
	test("parses HH:MM:SS.mmm chapter timestamps", () => {
		expect(parseColonSeparatedSeconds("00:00:00.000")).toBe(0);
		expect(parseColonSeparatedSeconds("00:01:30.000")).toBe(90);
		expect(parseColonSeparatedSeconds("01:02:03.500")).toBe(3723.5);
		expect(parseColonSeparatedSeconds("95.5")).toBe(95.5);
		expect(parseColonSeparatedSeconds("not-a-time")).toBeNaN();
		expect(parseColonSeparatedSeconds("")).toBeNaN();
		expect(parseColonSeparatedSeconds("01:invalid:00")).toBeNaN();
	});
});
