import { describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { pluginStorageData } from "@/services/plugins/plugin-data.service";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginStorageService } from "./plugin.storage";
import { assertStorageKey, serializeStorageValue } from "./plugin.storage.validator";

const db = useTestDatabase();

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

	test("accepts a value whose serialization is exactly the byte limit", () => {
		const value = "x".repeat(65_534); // the two JSON quote bytes bring it to 64 KiB
		expect(serializeStorageValue(value)).toBe(`"${value}"`);
	});

	test("refuses a value that cannot be serialized to JSON", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => serializeStorageValue(circular)).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.storage.invalid_value" }),
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

	test("caps the returned keys at ten thousand", async () => {
		const client = db.client();
		for (let start = 0; start < 10_001; start += 500) {
			const count = Math.min(500, 10_001 - start);
			await client.insert(schema.pluginStorage).values(
				Array.from({ length: count }, (_, index) => ({
					pluginId: "org.reelvault.bulk",
					key: `key-${start + index}`,
					value: "1",
				})),
			);
		}

		const keys = await pluginStorageService.list("org.reelvault.bulk");

		expect(keys).toHaveLength(10_000);
	});
});
