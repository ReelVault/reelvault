import { describe, expect, test } from "bun:test";
import { hashProfilePin, secureRandomInt, verifyProfilePin } from "./crypto.utils";

describe("profile pin utils", () => {
	test("hashes a pin and verifies it", async () => {
		const hash = await hashProfilePin("1234");
		expect(hash?.startsWith("$")).toBe(true);
		expect(await verifyProfilePin(hash ?? "", "1234")).toBe(true);
		expect(await verifyProfilePin(hash ?? "", "9999")).toBe(false);
	});

	test("returns undefined for absent pins", async () => {
		expect(await hashProfilePin(undefined)).toBeUndefined();
		expect(await hashProfilePin("")).toBeUndefined();
		expect(await hashProfilePin(null)).toBeUndefined();
	});

	test("verifies legacy plaintext pins", async () => {
		expect(await verifyProfilePin("1234", "1234")).toBe(true);
		expect(await verifyProfilePin("1234", "9999")).toBe(false);
	});

	test("rejects a malformed hash instead of falling back to plaintext", async () => {
		expect(await verifyProfilePin("$argon2id$not-a-real-hash", "$argon2id$not-a-real-hash")).toBe(false);
	});
});

describe("secureRandomInt", () => {
	test("stays within the inclusive range", () => {
		for (let index = 0; index < 1000; index++) {
			const value = secureRandomInt(100000, 999999);
			expect(value).toBeGreaterThanOrEqual(100000);
			expect(value).toBeLessThanOrEqual(999999);
			expect(Number.isInteger(value)).toBe(true);
		}
	});

	test("supports a single-value range", () => {
		expect(secureRandomInt(7, 7)).toBe(7);
	});

	test("rejects invalid ranges", () => {
		expect(() => secureRandomInt(5, 1)).toThrow();
		expect(() => secureRandomInt(1.5, 3)).toThrow();
	});
});
