import { afterEach, describe, expect, test } from "bun:test";
import type { PluginUiManifest } from "@reelvault/sdk/plugin";
import { pluginUiOverridesRepository } from "@/database/repositories/plugin-ui-overrides.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { pluginRegistry } from "./plugin.registry";
import { pluginUiSettingsService } from "./plugin-ui-settings.service";

const manifest: PluginUiManifest = {
	name: "Requests",
	version: "1.0.0",
	pages: [{ id: "requests", path: "requests", name: "Requests", tag: "rv-requests" }],
	dialogs: [{ id: "new", title: "New request", tag: "rv-new" }],
};

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

/** In-memory stand-in for the overrides table, shared by the repository stubs. */
function stubOverrides() {
	const rows = new Map<string, Set<string>>();
	stubs.push(
		stubMethod(pluginUiOverridesRepository, "listAll", () => Promise.resolve(new Map([...rows].map(([id, keys]) => [id, new Set(keys)])))),
		stubMethod(pluginUiOverridesRepository, "replaceForPlugin", (pluginId: string, keys: readonly string[]) => {
			if (keys.length === 0) rows.delete(pluginId);
			else rows.set(pluginId, new Set(keys));

			return Promise.resolve();
		}),
		stubMethod(pluginRegistry, "get", (id: string) => (id === "requests" ? { id } : undefined)),
		stubMethod(pluginRegistry, "getUiManifest", (id: string) => (id === "requests" ? manifest : undefined)),
	);

	return rows;
}

describe("pluginUiSettingsService", () => {
	test("lists every contribution as visible by default", async () => {
		stubOverrides();
		await pluginUiSettingsService.reset("requests");

		const settings = await pluginUiSettingsService.get("requests");

		expect(settings.enabled).toBe(true);
		expect(settings.contributions.map((item) => [item.key, item.enabled])).toEqual([
			["page:requests", true],
			["dialog:new", true],
		]);
	});

	test("hides the chosen contributions and the whole UI via the master switch", async () => {
		const rows = stubOverrides();

		const partial = await pluginUiSettingsService.update("requests", { enabled: true, disabledKeys: ["dialog:new"] });
		expect(partial.contributions.find((item) => item.key === "dialog:new")?.enabled).toBe(false);
		expect(partial.enabled).toBe(true);

		const all = await pluginUiSettingsService.update("requests", { enabled: false, disabledKeys: [] });
		expect(all.enabled).toBe(false);
		expect([...(rows.get("requests") ?? [])]).toEqual(["*"]);
	});

	test("rejects an unknown contribution key with a stable code", async () => {
		stubOverrides();

		let code: string | undefined;
		try {
			await pluginUiSettingsService.update("requests", { enabled: true, disabledKeys: ["page:ghost"] });
		} catch (error) {
			code = (error as { code?: string }).code;
		}

		expect(code).toBe("plugin_ui.unknown_contribution");
	});

	test("rejects an unknown plugin", async () => {
		stubOverrides();

		let code: string | undefined;
		try {
			await pluginUiSettingsService.get("missing");
		} catch (error) {
			code = (error as { code?: string }).code;
		}

		expect(code).toBe("plugin.not_found");
	});

	test("reset shows everything again", async () => {
		stubOverrides();
		await pluginUiSettingsService.update("requests", { enabled: false, disabledKeys: ["page:requests"] });

		await pluginUiSettingsService.reset("requests");

		const settings = await pluginUiSettingsService.get("requests");
		expect(settings.enabled).toBe(true);
		expect(settings.contributions.every((item) => item.enabled)).toBe(true);
	});

	test("drops switches for contributions an upgraded plugin no longer declares", async () => {
		const rows = stubOverrides();
		await pluginUiSettingsService.update("requests", { enabled: true, disabledKeys: ["page:requests", "dialog:new"] });

		stubs.push(
			stubMethod(pluginRegistry, "getUiManifest", (id: string) => (id === "requests" ? { ...manifest, dialogs: undefined } : undefined)),
		);
		await pluginUiSettingsService.pruneStale("requests");

		expect([...(rows.get("requests") ?? [])]).toEqual(["page:requests"]);
	});

	test("keeps every switch when the plugin has no interface manifest", async () => {
		const rows = stubOverrides();
		await pluginUiSettingsService.update("requests", { enabled: true, disabledKeys: ["page:requests"] });

		stubs.push(stubMethod(pluginRegistry, "getUiManifest", () => undefined));
		await pluginUiSettingsService.pruneStale("requests");

		expect([...(rows.get("requests") ?? [])]).toEqual(["page:requests"]);
	});
});
