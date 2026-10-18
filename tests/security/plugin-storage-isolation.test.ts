import { beforeEach, describe, expect, test } from "bun:test";
import { serverConfig } from "@/config/server/server.config";
import { pluginStorageService } from "@/plugins/capabilities/plugin.storage";
import { prepareSecuritySuite } from "./security.helper";

/**
 * Plugin key-value storage is keyed by (plugin id, key). The plugin id is bound by the
 * host when it builds the plugin's scope, so a plugin can only name its own keys. These
 * tests check the storage layer keeps that promise: identical key names never collide
 * across plugins, listings and deletions stay inside one plugin, concurrent updates do
 * not lose writes, and malformed keys or oversized values are refused with codes.
 */

prepareSecuritySuite();

const PLUGIN_A = "org.example.storage-a";
const PLUGIN_B = "org.example.storage-b";

beforeEach(async () => {
	await pluginStorageService.removeForPlugin(PLUGIN_A);
	await pluginStorageService.removeForPlugin(PLUGIN_B);
});

describe("plugin storage isolation", () => {
	test("the same key name holds independent values for two plugins", async () => {
		await pluginStorageService.set(PLUGIN_A, "settings", { owner: "a" });
		await pluginStorageService.set(PLUGIN_B, "settings", { owner: "b" });

		expect(await pluginStorageService.get(PLUGIN_A, "settings")).toEqual({ owner: "a" });
		expect(await pluginStorageService.get(PLUGIN_B, "settings")).toEqual({ owner: "b" });
	});

	test("a plugin cannot read a key it never wrote, even when another plugin has it", async () => {
		await pluginStorageService.set(PLUGIN_A, "secret-token", "only-for-a");

		expect(await pluginStorageService.get(PLUGIN_B, "secret-token")).toBeUndefined();
	});

	test("listing returns only the keys of the calling plugin, honouring the prefix", async () => {
		await pluginStorageService.set(PLUGIN_A, "cache.one", 1);
		await pluginStorageService.set(PLUGIN_A, "cache.two", 2);
		await pluginStorageService.set(PLUGIN_A, "other", 3);
		await pluginStorageService.set(PLUGIN_B, "cache.three", 4);

		expect((await pluginStorageService.list(PLUGIN_A, "cache.")).toSorted()).toEqual(["cache.one", "cache.two"]);
		expect(await pluginStorageService.list(PLUGIN_B)).toEqual(["cache.three"]);
	});

	test("deleting a key removes only that plugin's copy", async () => {
		await pluginStorageService.set(PLUGIN_A, "shared-name", "a");
		await pluginStorageService.set(PLUGIN_B, "shared-name", "b");

		await pluginStorageService.delete(PLUGIN_A, "shared-name");

		expect(await pluginStorageService.get(PLUGIN_A, "shared-name")).toBeUndefined();
		expect(await pluginStorageService.get(PLUGIN_B, "shared-name")).toBe("b");
	});

	test("removing a plugin's storage leaves every other plugin's data in place", async () => {
		await pluginStorageService.set(PLUGIN_A, "data", 1);
		await pluginStorageService.set(PLUGIN_B, "data", 2);

		await pluginStorageService.removeForPlugin(PLUGIN_A);

		expect(await pluginStorageService.list(PLUGIN_A)).toEqual([]);
		expect(await pluginStorageService.get(PLUGIN_B, "data")).toBe(2);
	});
});

describe("plugin storage integrity", () => {
	test("concurrent read-modify-write updates of one key lose no writes", async () => {
		await pluginStorageService.set(PLUGIN_A, "counter", 0);

		await Promise.all(
			Array.from({ length: 60 }, () =>
				pluginStorageService.update(PLUGIN_A, "counter", (current) => (typeof current === "number" ? current + 1 : 1)),
			),
		);

		expect(await pluginStorageService.get(PLUGIN_A, "counter")).toBe(60);
	});

	test("JSON values round-trip unchanged", async () => {
		const value = { nested: { list: [1, "two", null, true] }, text: "héllo ✓", empty: {} };
		await pluginStorageService.set(PLUGIN_A, "document", value);

		expect(await pluginStorageService.get(PLUGIN_A, "document")).toEqual(value);
	});

	test("malformed keys are refused with a stable code", async () => {
		for (const key of [
			"",
			"has space",
			"slash/key",
			"../escape",
			"nul\u0000key",
			"x".repeat(serverConfig.plugins.storage.maxKeyLength + 1),
		]) {
			await expect(pluginStorageService.set(PLUGIN_A, key, 1)).rejects.toMatchObject({ code: "plugin.storage.invalid_key" });
		}
	});

	test("values that JSON cannot represent are refused with a stable code", async () => {
		await expect(pluginStorageService.set(PLUGIN_A, "undef", undefined)).rejects.toMatchObject({ code: "plugin.storage.invalid_value" });
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		await expect(pluginStorageService.set(PLUGIN_A, "cycle", cyclic)).rejects.toMatchObject({ code: "plugin.storage.invalid_value" });
	});

	test("values above the configured size cap are refused and never stored", async () => {
		const oversized = "x".repeat(serverConfig.plugins.storage.maxValueBytes + 1);

		await expect(pluginStorageService.set(PLUGIN_A, "big", oversized)).rejects.toMatchObject({ code: "plugin.storage.value_too_large" });
		expect(await pluginStorageService.get(PLUGIN_A, "big")).toBeUndefined();
	});
});
