import { afterEach, describe, expect, test } from "bun:test";
import { pluginAccessBus } from "./plugin.access";

const PLUGIN_IDS = ["org.example.access", "org.example.broken", "org.example.slow"];

afterEach(() => {
	// The access bus is process-wide; a policy left behind would deny playback checks in later tests.
	for (const pluginId of PLUGIN_IDS) pluginAccessBus.offPlugin(pluginId);
});

describe("plugin access bus", () => {
	test("returns the first denial in registration order and skips policies that allow", async () => {
		pluginAccessBus.register("org.example.access", { id: "allows", beforeAccess: () => undefined });
		pluginAccessBus.register("org.example.access", {
			id: "expired",
			beforeAccess: () => ({ allowed: false, code: "EXPIRED", message: "Access expired" }),
		});
		pluginAccessBus.register("org.example.access", {
			id: "locked",
			beforeAccess: () => ({ allowed: false, code: "LOCKED", message: "Account locked" }),
		});

		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toMatchObject({
			allowed: false,
			code: "EXPIRED",
		});
	});

	test("stops denying once the plugin's policies are removed", async () => {
		pluginAccessBus.register("org.example.access", {
			id: "expired",
			beforeAccess: () => ({ allowed: false, code: "EXPIRED", message: "Access expired" }),
		});

		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toMatchObject({
			allowed: false,
			code: "EXPIRED",
		});

		pluginAccessBus.offPlugin("org.example.access");
		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toBeUndefined();
	});

	test("fails closed when a policy throws", async () => {
		pluginAccessBus.register("org.example.broken", { id: "broken", beforeAccess: () => Promise.reject(new Error("unavailable")) });
		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toMatchObject({
			allowed: false,
			code: "PLUGIN_ACCESS_UNAVAILABLE",
		});
	});

	test("fails closed when a policy times out", async () => {
		pluginAccessBus.register("org.example.slow", {
			id: "slow",
			beforeAccess: () =>
				new Promise(() => {
					// Never settles — the policy is expected to time out.
				}),
		});

		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toMatchObject({
			allowed: false,
			code: "PLUGIN_ACCESS_UNAVAILABLE",
		});
	});

	test("refuses a duplicate policy id with conflict code and attribution", () => {
		pluginAccessBus.register("org.example.access", { id: "gate", beforeAccess: () => undefined });

		expect(() => pluginAccessBus.register("org.example.access", { id: "gate", beforeAccess: () => undefined })).toThrow(
			expect.objectContaining({
				category: "conflict",
				code: "plugin.access_policy_duplicate",
				params: { policy: "gate" },
			}),
		);
	});

	test("stops denying once a policy is unsubscribed", async () => {
		const stop = pluginAccessBus.register("org.example.access", {
			id: "expired",
			beforeAccess: () => ({ allowed: false, code: "EXPIRED", message: "Access expired" }),
		});

		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toMatchObject({
			code: "EXPIRED",
		});

		stop();

		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toBeUndefined();
	});

	test("passes the access context to the policy", async () => {
		let seen: object = {};
		pluginAccessBus.register("org.example.access", {
			id: "observer",
			beforeAccess: (context) => {
				seen = context;

				return undefined;
			},
		});

		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toBeUndefined();

		expect(seen).toEqual({ userId: "user-1", resource: "stream", action: "play" });
	});
});
