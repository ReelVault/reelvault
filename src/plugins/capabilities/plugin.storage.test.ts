import { describe, expect, test } from "bun:test";
import { assertStorageKey, serializeStorageValue } from "./plugin.storage.validation";

describe("plugin storage", () => {
	test("accepts namespaced JSON values with safe keys", () => {
		expect(() => assertStorageKey("oauth.refresh-token.v1")).not.toThrow();
		expect(serializeStorageValue({ enabled: true, retries: 3 })).toBe('{"enabled":true,"retries":3}');
	});

	test("rejects unsafe keys and values that cannot fit in the key-value store", () => {
		expect(() => assertStorageKey("../private")).toThrow("Plugin storage key");
		expect(() => assertStorageKey("a".repeat(129))).toThrow("128 characters");
		expect(() => serializeStorageValue(undefined)).toThrow("JSON-serializable");
		expect(() => serializeStorageValue("x".repeat(64 * 1024))).toThrow("65536 bytes");
	});
});
