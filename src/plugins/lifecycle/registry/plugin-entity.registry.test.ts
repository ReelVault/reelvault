import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MetadataProvider } from "@reelvault/sdk/plugin";
import { PluginEntityTable } from "./plugin-entity.registry";

function createProvider(id: string): MetadataProvider {
	return {
		id,
		name: id.toUpperCase(),
		version: "1.0.0",
		initialize: async () => undefined,
		search: async () => [],
		getDetails: async () => null,
		getSeasonDetails: async () => null,
		getEpisodeDetails: async () => null,
	};
}

describe("PluginEntityTable", () => {
	let table: PluginEntityTable<MetadataProvider>;

	beforeEach(() => {
		table = new PluginEntityTable<MetadataProvider>("Provider", { sortById: true });
	});

	afterEach(() => table.clear());

	test("registers entities per plugin and resolves lookups by id", () => {
		const tmdb = createProvider("tmdb");
		table.register("plugin-a", [tmdb]);

		expect(table.get("tmdb")).toBe(tmdb);
		expect(table.getStatuses()).toEqual([{ id: "tmdb", name: "TMDB", version: "1.0.0", pluginId: "plugin-a" }]);
	});

	test("assertRegisterable rejects an entity id owned by another plugin and names the owner", () => {
		table.register("plugin-a", [createProvider("tmdb")]);

		expect(() => table.assertRegisterable([createProvider("tmdb")])).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.entity_conflict", params: { id: "tmdb", plugin: "plugin-a" } }),
		);
		table.assertRegisterable([createProvider("fresh")]);
	});

	test("refuses a registration that names the same id twice and registers nothing", () => {
		expect(() => table.register("plugin-a", [createProvider("tmdb"), createProvider("tmdb")])).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.entity_duplicate", params: { id: "tmdb" } }),
		);

		expect(table.get("tmdb")).toBeUndefined();
	});

	test("getAll and getStatuses list entities sorted by id and reflect a later registration", () => {
		table.register("plugin-a", [createProvider("zeta")]);
		expect(table.getAll().map((provider) => provider.id)).toEqual(["zeta"]);

		table.register("plugin-b", [createProvider("alpha")]);
		expect(table.getAll().map((provider) => provider.id)).toEqual(["alpha", "zeta"]);
		expect(table.getStatuses().map((status) => status.pluginId)).toEqual(["plugin-b", "plugin-a"]);
	});

	test("keeps insertion order unless sortById is set", () => {
		const unsorted = new PluginEntityTable<MetadataProvider>("Provider");
		unsorted.register("plugin-a", [createProvider("zeta")]);
		unsorted.register("plugin-b", [createProvider("alpha")]);

		expect(unsorted.getAll().map((provider) => provider.id)).toEqual(["zeta", "alpha"]);
		unsorted.clear();
	});

	test("removeForPlugin drops only that plugin's entities and frees their ids", () => {
		table.register("plugin-a", [createProvider("shared"), createProvider("a-only")]);
		table.register("plugin-b", [createProvider("b-only")]);

		table.removeForPlugin("plugin-a");

		expect(table.get("shared")).toBeUndefined();
		expect(table.get("a-only")).toBeUndefined();
		expect(table.get("b-only")).toMatchObject({ id: "b-only" });
		table.assertRegisterable([createProvider("shared")]);
	});

	test("clear empties the table", () => {
		table.register("plugin-a", [createProvider("tmdb")]);
		table.clear();

		expect(table.get("tmdb")).toBeUndefined();
		expect(table.getAll()).toEqual([]);
		expect(table.getStatuses()).toEqual([]);
	});
});
