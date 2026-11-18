import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";
import { serverConfig } from "@/config/server/server.config";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { removeTreeSync } from "@/utils/directory.utils";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { pluginsUiRoutes } from "./plugins-ui.routes";

const PLUGIN_ID = "org.example.ui";
const DIRECTORY = "ui-test-plugin-dir";

let root: string;
let pluginDir: string;
let originalPluginsPath: string;
let pluginState: "enabled" | "disabled" | undefined;
const stubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reelvault-plugin-ui-"));
	pluginDir = join(root, DIRECTORY);
	mkdirSync(pluginDir);
	pluginState = "enabled";

	originalPluginsPath = serverConfig.paths.plugins;
	serverConfig.paths.plugins = root;
	stubs.push(
		stubMethod(pluginManager, "getPluginDirectoryName", () => Promise.resolve(DIRECTORY)),
		stubMethod(pluginRegistry, "get", () => (pluginState ? { state: pluginState } : undefined)),
	);
});

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	serverConfig.paths.plugins = originalPluginsPath;
	removeTreeSync(root);
});

function writeAsset(relative: string, content: string): void {
	const target = join(pluginDir, relative);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function testApp() {
	return new Elysia().use(domainErrorsMiddleware).use(pluginsUiRoutes);
}

async function get(assetPath: string): Promise<Response> {
	return await testApp().handle(new Request(`http://localhost/plugins/ui/${PLUGIN_ID}/${assetPath}`));
}

test("a disabled or missing plugin no longer serves its UI bundle", async () => {
	pluginState = "disabled";
	let response = await get("dist/ui/index.js");
	expect(response.status).toBe(404);
	expect(((await response.json()) as { code: string }).code).toBe("plugin.not_found");

	pluginState = undefined;
	response = await get("dist/ui/index.js");
	expect(response.status).toBe(404);
	expect(((await response.json()) as { code: string }).code).toBe("plugin.not_found");
});

test("refuses to serve config.json from a plugin directory", async () => {
	writeAsset("config.json", '{"apiKey":"top-secret"}');

	const response = await get("config.json");
	const payload = (await response.json()) as { statusCode: number; code: string };

	expect(response.status).toBe(403);
	expect(payload).toMatchObject({ statusCode: 403, code: "plugin_ui.forbidden" });
	expect(JSON.stringify(payload)).not.toContain("top-secret");
});

test("requires a session for the role-filtered UI manifest", async () => {
	const response = await testApp().handle(new Request("http://localhost/plugins/ui/manifest"));
	const payload = (await response.json()) as { code: string };

	expect(response.status).toBe(401);
	expect(payload.code).toBe("auth.session_invalid");
});

test("serves the nearest index.html for an extension-less deep link", async () => {
	writeAsset("dist/ui/index.html", "<html>nearest-entry</html>");

	const response = await get("dist/ui/report/42");

	expect(response.status).toBe(200);
	expect(await response.text()).toBe("<html>nearest-entry</html>");
});

test("walks up to the plugin root for a deeply nested SPA entry", async () => {
	writeAsset("index.html", "<html>root-entry</html>");
	mkdirSync(join(pluginDir, "d1", "d2", "d3", "d4", "d5", "d6", "d7"), { recursive: true });

	const response = await get("d1/d2/d3/d4/d5/d6/d7/page");

	expect(response.status).toBe(200);
	expect(await response.text()).toBe("<html>root-entry</html>");
});

test("answers asset_not_found for a missing file with an extension", async () => {
	const response = await get("dist/ui/index.js");
	const payload = (await response.json()) as { code: string };

	expect(response.status).toBe(404);
	expect(payload.code).toBe("plugin_ui.asset_not_found");
});

test("answers asset_not_found when no index.html exists above the request", async () => {
	const response = await get("dist/ui/report/42");
	const payload = (await response.json()) as { code: string };

	expect(response.status).toBe(404);
	expect(payload.code).toBe("plugin_ui.asset_not_found");
});

test("keeps an existing CORS origin instead of overwriting it with a wildcard", async () => {
	writeAsset("dist/ui/app.js", 'console.log("ui");');
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.onBeforeHandle(({ set }) => {
			set.headers["access-control-allow-origin"] = "https://ui.example.test";
		})
		.use(pluginsUiRoutes);

	const response = await app.handle(new Request(`http://localhost/plugins/ui/${PLUGIN_ID}/dist/ui/app.js`));

	expect(await response.text()).toBe('console.log("ui");');
	expect(response.headers.get("access-control-allow-origin")).toBe("https://ui.example.test");
});
