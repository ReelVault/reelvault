import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PluginManifest, PluginRuntime, PluginUiManifest, ReelVaultPlugin } from "@reelvault/sdk/plugin";
import { pluginUiOverridesRepository } from "@/repositories/plugin-ui-overrides.repository";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginRegistry } from "./plugin.registry";
import { pluginUiSettingsService } from "./plugin-ui-settings.service";

useTestDatabase();

const PLUGIN_ID = "requests";
const plugin: ReelVaultPlugin = { setup: async () => undefined };
const manifest: PluginUiManifest = {
	name: "Requests",
	version: "1.0.0",
	pages: [{ id: "requests", path: "requests", name: "Requests", tag: "rv-requests" }],
	dialogs: [{ id: "new", title: "New request", tag: "rv-new" }],
};

/** Registers the plugin as the loader does, and sets its interface manifest when it has one. */
function registerPlugin(uiManifest?: PluginUiManifest): void {
	const pluginManifest: PluginManifest = { id: PLUGIN_ID, name: "Requests", version: "1.0.0", entry: "./dist/index.js", capabilities: [] };
	const runtime: PluginRuntime = {
		manifest: pluginManifest,
		plugin,
		state: "discovered",
		providerIds: [],
		subtitleProviderIds: [],
		analyzerIds: [],
		jobNames: [],
	};
	pluginRegistry.register(runtime, []);
	if (uiManifest) pluginRegistry.setUiManifest(PLUGIN_ID, uiManifest);
}

/** The hidden keys stored for the plugin, read back from the overrides table. */
async function storedKeys(): Promise<string[]> {
	return [...((await pluginUiOverridesRepository.listAll()).get(PLUGIN_ID) ?? [])];
}

beforeEach(async () => {
	pluginRegistry.clear();
	registerPlugin(manifest);
	// The service keeps the overrides in memory; reset drops that cache together with the rows.
	await pluginUiSettingsService.reset(PLUGIN_ID);
});

afterEach(() => {
	pluginRegistry.clear();
});

describe("pluginUiSettingsService", () => {
	test("lists every contribution as visible by default", async () => {
		const settings = await pluginUiSettingsService.get(PLUGIN_ID);

		expect(settings.enabled).toBe(true);
		expect(settings.contributions.map((item) => [item.key, item.enabled])).toEqual([
			["page:requests", true],
			["dialog:new", true],
		]);
	});

	test("hides the chosen contributions and the whole UI via the master switch", async () => {
		const partial = await pluginUiSettingsService.update(PLUGIN_ID, { enabled: true, disabledKeys: ["dialog:new"] });
		expect(partial.contributions.find((item) => item.key === "dialog:new")?.enabled).toBe(false);
		expect(partial.enabled).toBe(true);

		const all = await pluginUiSettingsService.update(PLUGIN_ID, { enabled: false, disabledKeys: [] });
		expect(all.enabled).toBe(false);
		expect(await storedKeys()).toEqual(["*"]);
	});

	test("rejects an unknown contribution key with a stable code and stores nothing", async () => {
		await expect(pluginUiSettingsService.update(PLUGIN_ID, { enabled: true, disabledKeys: ["page:ghost"] })).rejects.toMatchObject({
			code: "plugin_ui.unknown_contribution",
		});
		expect(await storedKeys()).toEqual([]);
	});

	test("rejects an unknown plugin", async () => {
		await expect(pluginUiSettingsService.get("missing")).rejects.toMatchObject({ code: "plugin.not_found" });
	});

	test("reset shows everything again", async () => {
		await pluginUiSettingsService.update(PLUGIN_ID, { enabled: false, disabledKeys: ["page:requests"] });

		await pluginUiSettingsService.reset(PLUGIN_ID);

		const settings = await pluginUiSettingsService.get(PLUGIN_ID);
		expect(settings.enabled).toBe(true);
		expect(settings.contributions.every((item) => item.enabled)).toBe(true);
		expect(await storedKeys()).toEqual([]);
	});

	test("drops switches for contributions an upgraded plugin no longer declares", async () => {
		await pluginUiSettingsService.update(PLUGIN_ID, { enabled: true, disabledKeys: ["page:requests", "dialog:new"] });

		const upgraded: PluginUiManifest = { name: "Requests", version: "1.0.1", pages: manifest.pages };
		pluginRegistry.setUiManifest(PLUGIN_ID, upgraded);
		await pluginUiSettingsService.pruneStale(PLUGIN_ID);

		expect(await storedKeys()).toEqual(["page:requests"]);
	});

	test("keeps every switch when the plugin has no interface manifest", async () => {
		await pluginUiSettingsService.update(PLUGIN_ID, { enabled: true, disabledKeys: ["page:requests"] });

		pluginRegistry.unregister(PLUGIN_ID);
		registerPlugin();
		await pluginUiSettingsService.pruneStale(PLUGIN_ID);

		expect(await storedKeys()).toEqual(["page:requests"]);
	});
});
