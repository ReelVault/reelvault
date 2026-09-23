import { describe, expect, test } from "bun:test";
import type { PluginHttpRoute } from "@sdk/plugin";
import { Type } from "@sinclair/typebox";
import { PluginRouteRegistry, PluginRouteValidationError } from "./plugin.routes";

const objectSchema = Type.Record(Type.String(), Type.Unknown());

describe("plugin ROUTES registry", () => {
	test("dispatches an owned route with parsed parameters and unregisters it", async () => {
		const registry = new PluginRouteRegistry();
		const route: PluginHttpRoute = {
			method: "POST",
			path: "/refresh/:mediaFileId",
			access: "user",
			params: Type.Object({ mediaFileId: Type.String() }),
			body: objectSchema,
			response: objectSchema,
			handler: ({ params, body, user }) => ({ status: 202, body: { ...params, body, userId: user.id } }),
		};
		registry.register("org.reelvault.trickplay", [route]);

		const resolved = registry.resolve("org.reelvault.trickplay", "POST", "/refresh/file-1");
		if (!resolved) throw new Error("Plugin HTTP route was not resolved");

		await expect(
			registry.dispatch(resolved, {
				params: resolved.params,
				query: {},
				body: { force: true },
				user: { id: "user-1", role: "user", profileId: "profile-1" },
			}),
		).resolves.toEqual({ status: 202, body: { mediaFileId: "file-1", body: { force: true }, userId: "user-1" } });

		registry.unregisterPlugin("org.reelvault.trickplay");
		expect(registry.resolve("org.reelvault.trickplay", "POST", "/refresh/file-1")).toBeUndefined();
	});

	test("rejects conflicting routes and malformed request data", async () => {
		const registry = new PluginRouteRegistry();
		const route: PluginHttpRoute = {
			method: "GET",
			path: "/status/:id",
			body: objectSchema,
			handler: () => ({ body: {} }),
		};
		registry.register("org.example.one", [route]);
		expect(() => registry.register("org.example.one", [{ ...route, path: "/status/:other" }])).toThrow("conflicts");
		// Different plugins can register the same route paths independently
		expect(() => registry.register("org.example.two", [route])).not.toThrow();

		const resolved = registry.resolve("org.example.one", "GET", "/status/1");
		if (!resolved) throw new Error("Plugin HTTP route was not resolved");

		await expect(
			registry.dispatch(resolved, { params: resolved.params, query: {}, body: "invalid", user: { id: "user-1", role: "user" } }),
		).rejects.toBeInstanceOf(PluginRouteValidationError);
	});

	test("rejects unsupported access levels at registration time", () => {
		const registry = new PluginRouteRegistry();
		expect(() =>
			registry.register("org.example.admin", [
				{
					method: "PUT",
					path: "/grant/:userId",
					// Runtime guard: the type is a closed union, but JS callers can still pass anything.
					access: JSON.parse('{"admin": ["update"]}'),
					handler: () => ({ body: {} }),
				},
			]),
		).toThrow("access");
	});
});
