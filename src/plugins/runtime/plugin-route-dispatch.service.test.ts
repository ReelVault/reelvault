import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PluginRouteValidationError, type ResolvedPluginRoute } from "./plugin.routes";
import { type PluginRouteDispatchInput, pluginRouteDispatchService } from "./plugin-route-dispatch.service";

function stubMethod<TArgs extends unknown[] = unknown[]>(
	target: object,
	method: string,
	impl: (...args: TArgs) => unknown,
): { calls: TArgs[]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: TArgs[] = [];
	const replacement = (...args: TArgs) => {
		calls.push(args);

		return impl(...args);
	};
	Reflect.set(target, method, replacement);

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

function createInput(overrides: Partial<PluginRouteDispatchInput> = {}): PluginRouteDispatchInput {
	return {
		pluginId: "org.reelvault.routed",
		method: "GET",
		path: "/items/42",
		query: { page: "2" },
		body: undefined,
		user: { id: "user-1", role: "user" },
		...overrides,
	};
}

function createResolvedRoute(access?: "admin" | "user"): ResolvedPluginRoute {
	return {
		route: { method: "GET", path: "/items/:id", handler: async () => ({ body: null }), ...(access !== undefined ? { access } : {}) },
		params: { id: "42" },
	};
}

describe("pluginRouteDispatchService", () => {
	let activeStubs: Array<{ restore(): void }> = [];
	let dispatchStub: { calls: unknown[][]; restore(): void };

	beforeEach(async () => {
		activeStubs = [];
		const { pluginRoutesRegistry } = await import("./plugin.routes");
		const { pluginRegistry } = await import("@/plugins/lifecycle/plugin.registry");
		const { usersRepository } = await import("@/database/repositories/users.repository");
		dispatchStub = stubMethod(pluginRoutesRegistry, "dispatch", () => ({ body: { ok: true } }));
		activeStubs.push(
			stubMethod(pluginRoutesRegistry, "resolve", (pluginId: string, method: string) =>
				pluginId === "org.reelvault.routed" && method === "GET" ? createResolvedRoute() : undefined,
			),
			dispatchStub,
			stubMethod(pluginRegistry, "get", (pluginId: string) => (pluginId === "org.reelvault.routed" ? { state: "enabled" } : undefined)),
			stubMethod(usersRepository, "findById", (userId: string) =>
				userId === "user-1" ? { id: userId, role: "admin" } : { id: userId, role: "user" },
			),
		);
	});

	afterEach(() => {
		for (const stub of activeStubs.toReversed()) stub.restore();

		activeStubs = [];
	});

	test("returns not_found when no route resolves", async () => {
		const { pluginRoutesRegistry } = await import("./plugin.routes");
		activeStubs.push(stubMethod(pluginRoutesRegistry, "resolve", () => undefined));

		await expect(pluginRouteDispatchService.dispatch(createInput({ path: "/missing" }))).resolves.toEqual({ type: "not_found" });
	});

	test("returns not_found when the plugin is registered but not enabled", async () => {
		const { pluginRegistry } = await import("@/plugins/lifecycle/plugin.registry");
		activeStubs.push(stubMethod(pluginRegistry, "get", () => ({ state: "disabled" })));

		await expect(pluginRouteDispatchService.dispatch(createInput())).resolves.toEqual({ type: "not_found" });
	});

	test("rejects unauthenticated callers before touching the route", async () => {
		await expect(pluginRouteDispatchService.dispatch(createInput({ user: { id: "" } }))).resolves.toEqual({
			type: "forbidden",
			message: "Authentication required",
		});
		expect(dispatchStub.calls).toEqual([]);
	});

	test("user access is the default and requires no role check", async () => {
		await expect(pluginRouteDispatchService.dispatch(createInput({ user: { id: "user-1", role: "user" } }))).resolves.toEqual({
			type: "success",
			status: 200,
			body: { ok: true },
			headers: undefined,
		});
	});

	test("admin access passes for admin role without a database lookup", async () => {
		const { pluginRoutesRegistry } = await import("./plugin.routes");
		activeStubs.push(stubMethod(pluginRoutesRegistry, "resolve", () => createResolvedRoute("admin")));

		const result = await pluginRouteDispatchService.dispatch(createInput({ user: { id: "user-1", role: "admin" } }));

		expect(result).toMatchObject({ type: "success", status: 200 });
	});

	test("admin access falls back to the stored user role for non-admin request roles", async () => {
		const { pluginRoutesRegistry } = await import("./plugin.routes");
		activeStubs.push(stubMethod(pluginRoutesRegistry, "resolve", () => createResolvedRoute("admin")));

		const result = await pluginRouteDispatchService.dispatch(createInput({ user: { id: "user-1", role: "user" } }));

		expect(result).toMatchObject({ type: "success" });
	});

	test("admin access is refused when the stored user is not an admin", async () => {
		const { pluginRoutesRegistry } = await import("./plugin.routes");
		const { usersRepository } = await import("@/database/repositories/users.repository");
		activeStubs.push(
			stubMethod(pluginRoutesRegistry, "resolve", () => createResolvedRoute("admin")),
			stubMethod(usersRepository, "findById", () => ({ id: "user-2", role: "user" })),
		);

		await expect(pluginRouteDispatchService.dispatch(createInput({ user: { id: "user-2", role: "user" } }))).resolves.toEqual({
			type: "forbidden",
			message: "Admin role required for this plugin route",
		});
	});

	test("maps schema validation errors to invalid_request and rethrows anything else", async () => {
		const { pluginRoutesRegistry } = await import("./plugin.routes");
		activeStubs.push(
			stubMethod(pluginRoutesRegistry, "dispatch", () => {
				throw new PluginRouteValidationError("Plugin HTTP body did not match its schema");
			}),
		);

		await expect(pluginRouteDispatchService.dispatch(createInput({ body: { bad: true } }))).resolves.toEqual({
			type: "invalid_request",
			message: "Plugin HTTP body did not match its schema",
		});

		activeStubs.push(
			stubMethod(pluginRoutesRegistry, "dispatch", () => {
				throw new Error("handler exploded");
			}),
		);
		await expect(pluginRouteDispatchService.dispatch(createInput({ body: { bad: true } }))).rejects.toThrow("handler exploded");
	});

	test("forwards params, query, headers, and a defaulted user to the route handler", async () => {
		await pluginRouteDispatchService.dispatch(createInput({ headers: { "x-custom": "1" }, user: { id: "user-9" } }));

		expect(dispatchStub.calls[0]?.[1]).toEqual({
			params: { id: "42" },
			query: { page: "2" },
			headers: { "x-custom": "1" },
			body: undefined,
			user: { id: "user-9", role: "user", profileId: undefined },
		});
	});
});
