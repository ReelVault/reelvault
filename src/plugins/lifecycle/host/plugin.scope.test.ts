import { beforeEach, describe, expect, test } from "bun:test";
import type { MetadataProvider, SubtitleProvider } from "@reelvault/sdk/plugin";
import { PluginScope } from "./plugin.scope";

function createProvider(id: string): MetadataProvider {
	return {
		id,
		name: id.toUpperCase(),
		version: "1.0.0",
		initialize: async () => undefined,
		search: async () => [],
		getDetails: async () => null,
		getSeasonDetails: async () => null,
		getEpisodeDetails: async () => null,
	};
}

function createSubtitleProvider(id: string): SubtitleProvider {
	return {
		id,
		name: id.toUpperCase(),
		version: "1.0.0",
		initialize: async () => undefined,
		search: async () => [],
		download: async () => null,
	};
}

describe("PluginScope", () => {
	let scope: PluginScope;

	beforeEach(() => {
		scope = new PluginScope();
	});

	test("enforces declared capabilities at use time", () => {
		scope.setDeclaredCapabilities(["mediaRead"]);
		expect(() => scope.useCapability("mediaRead")).not.toThrow();
		expect(() => scope.useCapability("storage")).toThrow("missing from plugin.json");
	});

	test("rejects entities without id, name, or version", () => {
		const broken = { ...createProvider("broken"), name: "" };
		expect(() => scope.addProvider(broken)).toThrow("must have id, name and version");
		expect(() => scope.addAnalyzer({ ...broken, id: "analyzer", analyze: () => ({}) })).toThrow("must have id, name and version");
		expect(() => scope.addSubtitleProvider({ ...createSubtitleProvider("ok"), version: "" })).toThrow("must have id, name and version");
	});

	test("rejects duplicate provider and subtitle provider ids", () => {
		scope.addProvider(createProvider("dup"));
		expect(() => scope.addProvider(createProvider("dup"))).toThrow("provider dup is registered more than once");

		scope.addSubtitleProvider(createSubtitleProvider("sub"));
		expect(() => scope.addSubtitleProvider(createSubtitleProvider("sub"))).toThrow("subtitle provider sub is registered more than once");
	});

	test("validates job names, schedule, and duplicates", () => {
		expect(() => scope.addJob({ name: "", handler: () => undefined })).toThrow("name must be non-empty");
		expect(() => scope.addJob({ name: "refresh", schedule: { cron: "0 24 * * *" }, handler: () => undefined })).toThrow(
			"Invalid cron expression",
		);

		scope.addJob({ name: "refresh", handler: () => undefined });
		expect(() => scope.addJob({ name: "refresh", handler: () => undefined })).toThrow("refresh is registered more than once");
		expect(scope.getJobNames()).toEqual(["refresh"]);
	});

	test("rejects scheduled tasks without id or name and routes without a duplicate key", () => {
		expect(() => scope.addScheduledTask({ id: "", name: "x", description: "x", defaultTriggers: [], run: async () => undefined })).toThrow(
			"must have id and name",
		);

		scope.addHttpRoute({ method: "GET", path: "/items", handler: async () => ({ body: null }) });
		expect(() => scope.addHttpRoute({ method: "GET", path: "/items", handler: async () => ({ body: null }) })).toThrow(
			"GET /items is registered more than once",
		);
	});

	test("enqueueJob rejects names that were never registered", async () => {
		await expect(scope.enqueueJob("org.reelvault.x", "missing", {})).rejects.toThrow("not registered");
		await expect(scope.enqueueJobs("org.reelvault.x", "missing", [{ data: {} }])).rejects.toThrow("not registered");
	});

	test("cleanup runs unsubscribers in reverse and disposes entities reversed", async () => {
		const { pluginEventBus } = await import("../../runtime/plugin.events");
		const calls: string[] = [];
		const provider = {
			...createProvider("p1"),
			dispose: () => {
				calls.push("provider");
			},
		};
		const subtitle = {
			...createSubtitleProvider("s1"),
			dispose: () => {
				calls.push("subtitle");
			},
		};
		const analyzer = {
			id: "a1",
			name: "A1",
			version: "1.0.0",
			analyze: () => ({}),
			dispose: () => {
				calls.push("analyzer");
			},
		};
		scope.addProvider(provider);
		scope.addSubtitleProvider(subtitle);
		scope.addAnalyzer(analyzer);
		scope.subscribe("org.reelvault.x", "plugin.enabled", ({ pluginId }) => {
			if (pluginId === "org.reelvault.x") calls.push("event");
		});

		await pluginEventBus.emit("plugin.enabled", { pluginId: "org.reelvault.x" });
		expect(calls).toEqual(["event"]);

		calls.length = 0;
		await scope.cleanup();
		expect(calls.toSorted()).toEqual(["analyzer", "provider", "subtitle"]);

		calls.length = 0;
		await pluginEventBus.emit("plugin.enabled", { pluginId: "org.reelvault.x" });
		expect(calls).toEqual([]);
	});

	test("swallows disposal errors so remaining entities still dispose", async () => {
		const calls: string[] = [];
		const broken = {
			...createProvider("broken"),
			dispose: () => {
				throw new Error("dispose failed");
			},
		};
		const healthy = {
			...createProvider("healthy"),
			dispose: () => {
				calls.push("healthy");
			},
		};
		scope.addProvider(broken);
		scope.addProvider(healthy);

		await scope.cleanup();
		expect(calls).toEqual(["healthy"]);
	});

	test("stores runtime directory and ui manifest accessors", () => {
		expect(scope.getRuntimeDirectory()).toBeUndefined();
		scope.setRuntimeDirectory("/tmp/mirror");
		expect(scope.getRuntimeDirectory()).toBe("/tmp/mirror");

		expect(scope.getUiManifest()).toBeUndefined();
		scope.setUiManifest({ name: "UI", version: "1.0.0", entry: "./ui.js" });
		expect(scope.getUiManifest()?.name).toBe("UI");
	});
});
