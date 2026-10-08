import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/middleware/domain-errors.middleware";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { pluginsUiRoutes } from "./plugins-ui.routes";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

async function requestAsset(state: "enabled" | "disabled" | undefined): Promise<{ status: number; code: string }> {
	stubs.push(
		stubMethod(pluginManager, "getPluginDirectoryName", () => Promise.resolve("ui-test-plugin-dir")),
		stubMethod(pluginRegistry, "get", () => (state ? { state } : undefined)),
	);
	const app = new Elysia().use(domainErrorsMiddleware).use(pluginsUiRoutes);
	const res = await app.handle(new Request("http://localhost/plugins/ui/org.example.ui/dist/ui/index.js"));

	return { status: res.status, code: ((await res.json()) as { code: string }).code };
}

test("a disabled plugin no longer serves its UI bundle", async () => {
	expect(await requestAsset("disabled")).toEqual({ status: 404, code: "plugin.not_found" });
	expect(await requestAsset(undefined)).toEqual({ status: 404, code: "plugin.not_found" });
});

test("an enabled plugin reaches the asset lookup", async () => {
	expect(await requestAsset("enabled")).toEqual({ status: 404, code: "plugin_ui.asset_not_found" });
});
