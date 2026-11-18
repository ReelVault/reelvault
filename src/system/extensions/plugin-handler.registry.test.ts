import { describe, expect, test } from "bun:test";
import { PluginHandlerTable } from "./plugin-handler.registry";

describe("plugin handler table", () => {
	test("counts plugins with handlers and forgets a plugin after its last handler leaves", () => {
		const table = new PluginHandlerTable<string>();
		table.register("plugin-a", "first");
		table.register("plugin-a", "second");
		table.register("plugin-b", "other");
		expect(table.size).toBe(2);

		table.remove("plugin-a", "first");
		expect(table.size).toBe(2);
		expect(table.all()).toEqual(["second", "other"]);

		table.remove("plugin-a", "second");
		expect(table.size).toBe(1);
		expect(table.all()).toEqual(["other"]);

		table.remove("plugin-b", "other");
		expect(table.size).toBe(0);
		expect(table.all()).toEqual([]);
		expect(table.entries()).toEqual([]);
	});

	test("returns handlers and entries in plugin then registration order", () => {
		const table = new PluginHandlerTable<string>();
		table.register("plugin-a", "a1");
		table.register("plugin-b", "b1");
		table.register("plugin-a", "a2");

		expect(table.all()).toEqual(["a1", "a2", "b1"]);
		expect(table.entries()).toEqual([
			{ pluginId: "plugin-a", handler: "a1" },
			{ pluginId: "plugin-a", handler: "a2" },
			{ pluginId: "plugin-b", handler: "b1" },
		]);
	});
});
