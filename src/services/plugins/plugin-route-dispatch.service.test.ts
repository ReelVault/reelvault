import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PluginHttpRequest, PluginHttpRoute, PluginManifest, PluginRuntime, ReelVaultPlugin } from "@reelvault/sdk/plugin";
import { Type } from "@sinclair/typebox";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { pluginRoutesRegistry } from "@/plugins/runtime/plugin.routes";
import { insertUsers } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { type PluginRouteDispatchInput, pluginRouteDispatchService } from "./plugin-route-dispatch.service";

// Routes, plugin state and users run against the real registries and the migrated test database.
// The plugin's own route handler is the only fake: it stands in for code a plugin directory would load.
const db = useTestDatabase();
const PLUGIN_ID = "org.reelvault.routed";
const manifest: PluginManifest = { id: PLUGIN_ID, name: "Routed plugin", version: "1.0.0", entry: "./dist/index.js", capabilities: [] };
const plugin: ReelVaultPlugin = { setup: async () => undefined };

/** Requests the route handler received, in order. */
const handled: PluginHttpRequest[] = [];

function echoRoute(overrides: Partial<PluginHttpRoute> = {}): PluginHttpRoute {
	return {
		method: "GET",
		path: "/items/:id",
		handler: (request) => {
			handled.push(request);

			return Promise.resolve({ body: { ok: true } });
		},
		...overrides,
	};
}

/** Registers the plugin with its routes, then enables or disables it. */
function registerPlugin(routes: PluginHttpRoute[], state: "enabled" | "disabled" = "enabled"): void {
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
	if (state === "enabled") pluginRegistry.enable(PLUGIN_ID);
	else pluginRegistry.disable(PLUGIN_ID);
	pluginRoutesRegistry.register(PLUGIN_ID, routes);
}

function createInput(overrides: Partial<PluginRouteDispatchInput> = {}): PluginRouteDispatchInput {
	return {
		pluginId: PLUGIN_ID,
		method: "GET",
		path: "/items/42",
		query: { page: "2" },
		body: undefined,
		user: { id: "user-1", role: "user" },
		...overrides,
	};
}

beforeEach(async () => {
	await insertUsers(db.client(), [
		{ id: "user-1", name: "Admin", email: "admin@example.test", emailVerified: true, role: "admin" },
		{ id: "user-2", name: "Member", email: "member@example.test", emailVerified: true, role: "user" },
	]);
});

afterEach(() => {
	pluginRegistry.clear();
	pluginRoutesRegistry.unregisterPlugin(PLUGIN_ID);
	handled.length = 0;
});

describe("pluginRouteDispatchService", () => {
	test("returns not_found when no route matches the path", async () => {
		registerPlugin([echoRoute()]);

		await expect(pluginRouteDispatchService.dispatch(createInput({ path: "/missing" }))).resolves.toEqual({ type: "not_found" });
	});

	test("returns not_found without running the handler when the plugin is disabled", async () => {
		registerPlugin([echoRoute()], "disabled");

		await expect(pluginRouteDispatchService.dispatch(createInput())).resolves.toEqual({ type: "not_found" });
		expect(handled).toEqual([]);
	});

	test("rejects unauthenticated callers before the route handler runs", async () => {
		registerPlugin([echoRoute()]);

		await expect(pluginRouteDispatchService.dispatch(createInput({ user: { id: "" } }))).resolves.toMatchObject({ type: "forbidden" });
		expect(handled).toEqual([]);
	});

	test("a route without an access rule is open to any signed-in user", async () => {
		registerPlugin([echoRoute()]);

		await expect(pluginRouteDispatchService.dispatch(createInput({ user: { id: "user-2", role: "user" } }))).resolves.toMatchObject({
			type: "success",
			status: 200,
			body: { ok: true },
		});
	});
});

describe("pluginRouteDispatchService access rules", () => {
	test("admin routes accept the request's admin role even when the stored role is user", async () => {
		registerPlugin([echoRoute({ access: "admin" })]);

		// user-2 is stored as a plain user, so only the request's own role can make this pass.
		await expect(pluginRouteDispatchService.dispatch(createInput({ user: { id: "user-2", role: "admin" } }))).resolves.toMatchObject({
			type: "success",
			status: 200,
		});
	});

	test("admin routes check the stored role when the request role is not admin", async () => {
		registerPlugin([echoRoute({ access: "admin" })]);

		// user-1 is stored as an admin.
		await expect(pluginRouteDispatchService.dispatch(createInput({ user: { id: "user-1", role: "user" } }))).resolves.toMatchObject({
			type: "success",
		});
	});

	test("admin routes refuse a caller whose stored role is not admin", async () => {
		registerPlugin([echoRoute({ access: "admin" })]);

		await expect(pluginRouteDispatchService.dispatch(createInput({ user: { id: "user-2", role: "user" } }))).resolves.toMatchObject({
			type: "forbidden",
		});
		expect(handled).toEqual([]);
	});
});

describe("pluginRouteDispatchService request handling", () => {
	test("reports a body that breaks the route's schema as invalid_request without running the handler", async () => {
		registerPlugin([echoRoute({ method: "POST", path: "/items", body: Type.Object({ count: Type.Number() }) })]);

		await expect(
			pluginRouteDispatchService.dispatch(createInput({ method: "POST", path: "/items", body: { bad: true } })),
		).resolves.toMatchObject({ type: "invalid_request" });
		expect(handled).toEqual([]);
	});

	test("rethrows an error the route handler throws", async () => {
		const handlerFailure = new Error("handler exploded");
		registerPlugin([echoRoute({ handler: () => Promise.reject(handlerFailure) })]);

		await expect(pluginRouteDispatchService.dispatch(createInput())).rejects.toBe(handlerFailure);
	});

	test("passes params, query, headers and the caller to the handler, defaulting the role to user", async () => {
		registerPlugin([echoRoute()]);

		await pluginRouteDispatchService.dispatch(createInput({ headers: { "x-custom": "1" }, user: { id: "user-9" } }));

		expect(handled).toEqual([
			{
				params: { id: "42" },
				query: { page: "2" },
				headers: { "x-custom": "1" },
				body: undefined,
				user: { id: "user-9", role: "user", profileId: undefined },
			},
		]);
	});
});
