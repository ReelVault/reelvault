import { describe, expect, test } from "bun:test";
import { sanitizeLogValue } from "./sanitize.utils";

describe("sanitizeLogValue", () => {
	test("does not log a password nested nine levels deep", () => {
		const payload = { a: { b: { c: { d: { e: { f: { g: { h: { password: "hunter2" } } } } } } } } };

		const sanitized: unknown = sanitizeLogValue(payload);

		expect(sanitized).toEqual({ a: { b: { c: { d: { e: { f: { g: { h: "[MaxDepth]" } } } } } } } });
	});
});
