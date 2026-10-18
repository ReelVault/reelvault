import { beforeEach, describe, expect, test } from "bun:test";
import type { MetadataProvider, PluginNotificationChannel, SubtitleProvider } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { dispatchNotificationToChannels } from "@/plugins/runtime/notification-channel.registry";
import { DomainError } from "@/utils/domain.errors";
import { PluginScope } from "./plugin.scope";

/** The registration-limit code thrown by `register`, or undefined when it succeeds. */
function limitCodeOf(register: () => void): string | undefined {
	try {
		register();
	} catch (error) {
		return error instanceof DomainError && error.category === "validation" ? error.code : undefined;
	}

	return undefined;
}

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

describe("PluginScope registration", () => {
	let scope: PluginScope;

	beforeEach(() => {
		scope = new PluginScope();
	});

	test("enforces declared capabilities at use time", () => {
		scope.setDeclaredCapabilities(["mediaRead"]);
		scope.useCapability("mediaRead");
		expect(() => scope.useCapability("storage")).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.capability_undeclared" }),
		);
	});

	test("refuses a notification channel until the plugin id is bound, then delivers to it until cleanup", async () => {
		const delivered: string[] = [];
		const channel: PluginNotificationChannel = {
			id: "webhook",
			deliver: (notification) => {
				delivered.push(notification.title);

				return Promise.resolve();
			},
		};
		const notify = () => dispatchNotificationToChannels({ id: "n-1", userId: "user-1", type: "test", title: "Hello" });

		expect(() => scope.registerNotificationChannelScope(channel)).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.scope_not_bound" }),
		);

		// The loader binds the id before setup(), so channels registered during
		// setup() carry the plugin namespace.
		scope.bindPluginId("org.example.plugin");
		scope.setDeclaredCapabilities(["notificationChannel"]);
		scope.registerNotificationChannelScope(channel);
		await notify();
		expect(delivered).toEqual(["Hello"]);

		await scope.cleanup();
		await notify();
		expect(delivered).toEqual(["Hello"]);
	});

	test("rejects entities without id, name, or version", () => {
		const broken = { ...createProvider("broken"), name: "" };
		expect(() => scope.addProvider(broken)).toThrow(expect.objectContaining({ category: "validation", code: "plugin.entity_invalid" }));
		expect(() => scope.addAnalyzer({ ...broken, id: "analyzer", analyze: () => ({}) })).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.entity_invalid",
			}),
		);
		expect(() => scope.addSubtitleProvider({ ...createSubtitleProvider("ok"), version: "" })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.entity_invalid" }),
		);
	});

	test("rejects duplicate provider and subtitle provider ids", () => {
		scope.addProvider(createProvider("dup"));
		expect(() => scope.addProvider(createProvider("dup"))).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.entity_duplicate" }),
		);

		scope.addSubtitleProvider(createSubtitleProvider("sub"));
		expect(() => scope.addSubtitleProvider(createSubtitleProvider("sub"))).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.entity_duplicate" }),
		);
	});

	test("validates job names, schedule, and duplicates", () => {
		expect(() => scope.addJob({ name: "", handler: () => undefined })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.job_name_required" }),
		);
		expect(() => scope.addJob({ name: "refresh", schedule: { cron: "0 24 * * *" }, handler: () => undefined })).toThrow(
			expect.objectContaining({ category: "validation", code: "worker.cron_invalid" }),
		);

		scope.addJob({ name: "refresh", handler: () => undefined });
		expect(() => scope.addJob({ name: "refresh", handler: () => undefined })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.job_duplicate" }),
		);
		expect(scope.getJobNames()).toEqual(["refresh"]);
	});

	test("rejects scheduled tasks without id or name and routes without a duplicate key", () => {
		expect(() => scope.addScheduledTask({ id: "", name: "x", description: "x", defaultTriggers: [], run: async () => undefined })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.scheduled_task_invalid" }),
		);

		scope.addHttpRoute({ method: "GET", path: "/items", handler: async () => ({ body: null }) });
		expect(() => scope.addHttpRoute({ method: "GET", path: "/items", handler: async () => ({ body: null }) })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.route_duplicate" }),
		);
	});
});

describe("PluginScope registration limits", () => {
	let scope: PluginScope;

	beforeEach(() => {
		scope = new PluginScope();
	});

	test("caps routes, jobs and scheduled tasks per plugin with a registration-limit code", () => {
		const limits = serverConfig.plugins.registration;

		for (let index = 0; index < limits.maxHttpRoutes; index++) {
			scope.addHttpRoute({ method: "GET", path: `/items/${index}`, handler: async () => ({ body: null }) });
		}
		expect(limitCodeOf(() => scope.addHttpRoute({ method: "GET", path: "/one-too-many", handler: async () => ({ body: null }) }))).toBe(
			"plugin.registration_limit.routes",
		);

		for (let index = 0; index < limits.maxJobs; index++) {
			scope.addJob({ name: `job-${index}`, handler: () => undefined });
		}
		expect(limitCodeOf(() => scope.addJob({ name: "one-too-many", handler: () => undefined }))).toBe("plugin.registration_limit.jobs");

		for (let index = 0; index < limits.maxScheduledTasks; index++) {
			scope.addScheduledTask({ id: `task-${index}`, name: "x", description: "x", defaultTriggers: [], run: async () => undefined });
		}
		expect(
			limitCodeOf(() =>
				scope.addScheduledTask({ id: "one-too-many", name: "x", description: "x", defaultTriggers: [], run: async () => undefined }),
			),
		).toBe("plugin.registration_limit.scheduled_tasks");
	});

	test("caps metadata providers per plugin", () => {
		const limits = serverConfig.plugins.registration;

		for (let index = 0; index < limits.maxHandlers; index++) {
			scope.addProvider(createProvider(`provider-${index}`));
		}
		expect(limitCodeOf(() => scope.addProvider(createProvider("one-too-many")))).toBe("plugin.registration_limit.providers");
	});
});

describe("PluginScope lifecycle", () => {
	let scope: PluginScope;

	beforeEach(() => {
		scope = new PluginScope();
	});

	test("enqueueJob rejects names that were never registered", async () => {
		await expect(scope.enqueueJob("org.reelvault.x", "missing", {})).rejects.toMatchObject({
			category: "validation",
			code: "plugin.job_not_registered",
		});
		await expect(scope.enqueueJobs("org.reelvault.x", "missing", [{ data: {} }])).rejects.toMatchObject({
			category: "validation",
			code: "plugin.job_not_registered",
		});
	});

	test("disposes every provider, subtitle provider and analyzer and stops event delivery on cleanup", async () => {
		const { pluginEventBus } = await import("../../../system/extensions/plugin.events");
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
});

describe("PluginScope accessors", () => {
	let scope: PluginScope;

	beforeEach(() => {
		scope = new PluginScope();
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
