import { describe, expect, test } from "bun:test";
import { pluginAccessBus } from "./plugin.access";

describe("plugin access bus", () => {
	test("returns the first denial and removes policies with their plugin", async () => {
		pluginAccessBus.register("org.example.access", {
			id: "expired",
			beforeAccess: () => ({ allowed: false, code: "EXPIRED", message: "Access expired" }),
		});

		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toEqual({
			allowed: false,
			code: "EXPIRED",
			message: "Access expired",
		});

		pluginAccessBus.offPlugin("org.example.access");
		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toBeUndefined();
	});

	test("fails closed when a policy throws", async () => {
		pluginAccessBus.register("org.example.broken", { id: "broken", beforeAccess: () => Promise.reject(new Error("unavailable")) });
		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toEqual({
			allowed: false,
			code: "PLUGIN_ACCESS_UNAVAILABLE",
			message: "Access could not be verified",
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

		await expect(pluginAccessBus.check({ userId: "user-1", resource: "stream", action: "play" })).resolves.toEqual({
			allowed: false,
			code: "PLUGIN_ACCESS_UNAVAILABLE",
			message: "Access could not be verified",
		});
	});
});
