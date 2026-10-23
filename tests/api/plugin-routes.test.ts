import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { PluginHttpMethod, PluginHttpRoute, PluginManifest, PluginRuntime, ReelVaultPlugin } from "@reelvault/sdk/plugin";
import Elysia from "elysia";
import { apiRouter } from "@/api/routes/api.routes";
import { webStaticPlugin } from "@/api/web/web-static.plugin";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { pluginRoutesRegistry } from "@/plugins/runtime/plugin.routes";
import { installSessionStub, prepareSecuritySuite } from "../security/security.helper";

// The `/v1` router with the bundled web UI mounted after it, the same order createHttpApp uses.
// Routes and plugin state run against the real registries; the plugin's handler is the only fake.
prepareSecuritySuite();
const sessionStub = installSessionStub();
afterAll(() => sessionStub.restore());

const app = new Elysia().use(apiRouter).use(webStaticPlugin);

const PLUGIN_ID = "org.reelvault.trailers";
const manifest: PluginManifest = { id: PLUGIN_ID, name: "Trailers", version: "1.0.2", entry: "./index.ts", capabilities: [] };
const plugin: ReelVaultPlugin = { setup: async () => undefined };
const SESSION_COOKIE = "better-auth.session_token=user-token";

/** A route that answers with the method it was called with and the `title` query value it received. */
function echoRoute(method: PluginHttpMethod, path: string): PluginHttpRoute {
	return {
		method,
		path,
		handler: async ({ query }) => ({ body: { method, title: query.title ?? null } }),
	};
}

function registerPlugin(routes: PluginHttpRoute[]): void {
	const runtime: PluginRuntime = {
		manifest,
		plugin,
		state: "discovered",
		providerIds: [],
		subtitleProviderIds: [],
		analyzerIds: [],
		jobNames: [],
	};
	pluginRegistry.register(runtime, []);
	pluginRegistry.enable(PLUGIN_ID);
	pluginRoutesRegistry.register(PLUGIN_ID, routes);
}

async function signedInRequest(method: string, path: string): Promise<Response> {
	return await app.handle(new Request(`http://localhost${path}`, { method, headers: { cookie: SESSION_COOKIE } }));
}

afterEach(() => {
	pluginRegistry.clear();
	pluginRoutesRegistry.unregisterPlugin(PLUGIN_ID);
});

describe("plugin routes through the full HTTP router", () => {
	test("answers a GET to a plugin's nested route with the plugin's body and query", async () => {
		registerPlugin([echoRoute("GET", "/trailer")]);

		const response = await signedInRequest("GET", `/v1/plugins/${PLUGIN_ID}/trailer?title=Heat`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ method: "GET", title: "Heat" });
	});

	test("answers a GET to a plugin's root route", async () => {
		registerPlugin([echoRoute("GET", "/")]);

		const response = await signedInRequest("GET", `/v1/plugins/${PLUGIN_ID}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ method: "GET", title: null });
	});

	test.each(["POST", "PUT", "PATCH", "DELETE"] as const)("forwards a %s to the plugin's nested route", async (method) => {
		registerPlugin([echoRoute(method, "/trailer")]);

		const response = await signedInRequest(method, `/v1/plugins/${PLUGIN_ID}/trailer`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ method, title: null });
	});

	test("reports a request for an undeclared plugin route with the plugin's not-found code", async () => {
		registerPlugin([echoRoute("GET", "/trailer")]);

		const response = await signedInRequest("GET", `/v1/plugins/${PLUGIN_ID}/missing`);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ statusCode: 404, code: "plugin.route_not_found" });
	});
});
