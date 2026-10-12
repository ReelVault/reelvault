import { afterEach, describe, expect, test } from "bun:test";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { DomainError } from "@/utils/errors";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { adminService } from "./admin.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("adminService.setPluginsEnabled", () => {
	test("attempts every plugin and reports each outcome, so one failure does not stop the rest", async () => {
		const setEnabled = stubMethod(pluginManager, "setEnabled", (pluginId: string) =>
			pluginId === "org.example.broken"
				? Promise.reject(new DomainError("not_found", "Plugin not found: org.example.broken"))
				: Promise.resolve(),
		);
		stubs.push(setEnabled);

		const result = await adminService.setPluginsEnabled({
			enabled: true,
			pluginIds: ["org.example.a", "org.example.broken", "org.example.b"],
		});

		expect(setEnabled.calls).toEqual([
			["org.example.a", true],
			["org.example.broken", true],
			["org.example.b", true],
		]);
		expect(result.results).toEqual([
			{ pluginId: "org.example.a", ok: true },
			{ pluginId: "org.example.broken", ok: false, error: "Plugin not found: org.example.broken", errorCode: "not_found" },
			{ pluginId: "org.example.b", ok: true },
		]);
	});

	test("passes the disable state through to each plugin", async () => {
		const setEnabled = stubMethod(pluginManager, "setEnabled", () => Promise.resolve());
		stubs.push(setEnabled);

		await adminService.setPluginsEnabled({ enabled: false, pluginIds: ["org.example.only"] });

		expect(setEnabled.calls).toEqual([["org.example.only", false]]);
	});
});

describe("adminService.setPluginCspEnabled", () => {
	test("persists the refusal, then reports a plugin that is not loaded as not found", async () => {
		const setCsp = stubMethod(pluginManager, "setPluginCspDisabled", () => Promise.resolve());
		stubs.push(setCsp);
		const details = stubMethod(pluginManager, "getPackageDetails", () => Promise.resolve({ capabilities: [], cspDisabled: false }));
		stubs.push(details);

		// The plugin is not loaded in this test, so the status lookup comes back empty and the method reports it.
		await expect(adminService.setPluginCspEnabled("org.example.csp", false)).rejects.toThrow("Plugin not found");
		expect(setCsp.calls).toEqual([["org.example.csp", true]]);
	});
});
