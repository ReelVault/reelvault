import { describe, expect, test } from "bun:test";
import { pluginStorageData } from "@/app/plugins/plugin-data.service";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { pluginStorageService } from "./plugin.storage";
import { assertStorageKey, serializeStorageValue } from "./plugin.storage.validator";

describe("plugin storage", () => {
	test("accepts namespaced JSON values with safe keys", () => {
		expect(serializeStorageValue({ enabled: true, retries: 3 })).toBe('{"enabled":true,"retries":3}');
	});

	test("refuses a key with path characters", () => {
		expect(() => assertStorageKey("../private")).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.storage.invalid_key" }),
		);
	});

	test("refuses a key longer than the storage limit", () => {
		expect(() => assertStorageKey("a".repeat(129))).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.storage.invalid_key" }),
		);
	});

	test("refuses a value that does not serialize to JSON", () => {
		expect(() => serializeStorageValue(undefined)).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.storage.invalid_value" }),
		);
	});

	test("refuses a value larger than the key-value store's per-value limit", () => {
		expect(() => serializeStorageValue("x".repeat(64 * 1024))).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.storage.value_too_large" }),
		);
	});

	test("a corrupt stored value fails with a specific code instead of a generic error", async () => {
		const stub = stubMethod(pluginStorageData, "findValue", () => Promise.resolve("not-json"));
		try {
			await expect(pluginStorageService.get("example.plugin", "settings")).rejects.toMatchObject({
				category: "internal",
				code: "plugin.storage_corrupt",
			});
		} finally {
			stub.restore();
		}
	});
});
