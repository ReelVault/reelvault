import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlaybackArtifactWrite } from "@reelvault/sdk/common";
import type {
	BeforeArtifactCreateHook,
	BeforeMediaRecognitionHook,
	BeforeMetadataSaveHook,
	MediaAnalyzer,
	MetadataProvider,
	PluginAccessPolicy,
	PluginCapabilityName,
	PluginEventName,
	PluginHost,
	PluginHttpRoute,
	PluginJobDefinition,
	PluginJobHandle,
	PluginScheduledTaskDefinition,
	SubtitleProvider,
} from "@reelvault/sdk/plugin";
import type { PluginEventHandlerErased, PluginScopeApi } from "./plugin.scope";
import { createPluginHost } from "./plugin-host.factory";

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

class ScopeSpy implements PluginScopeApi {
	readonly used: PluginCapabilityName[] = [];
	readonly providers: MetadataProvider[] = [];
	readonly analyzers: MediaAnalyzer[] = [];
	readonly subtitleProviders: SubtitleProvider[] = [];
	readonly jobs: PluginJobDefinition[] = [];
	readonly tasks: PluginScheduledTaskDefinition[] = [];
	readonly routes: PluginHttpRoute[] = [];
	readonly subscriptions: Array<{ pluginId: string; event: PluginEventName }> = [];
	readonly hooks: string[] = [];
	readonly policies: PluginAccessPolicy[] = [];
	readonly enqueues: Array<{ name: string; data: unknown }> = [];

	useCapability(name: PluginCapabilityName): void {
		this.used.push(name);
	}

	addAnalyzer(analyzer: MediaAnalyzer): void {
		this.analyzers.push(analyzer);
	}

	addProvider(provider: MetadataProvider): void {
		this.providers.push(provider);
	}

	addSubtitleProvider(provider: SubtitleProvider): void {
		this.subtitleProviders.push(provider);
	}

	addJob(definition: PluginJobDefinition): void {
		this.jobs.push(definition);
	}

	addScheduledTask(task: PluginScheduledTaskDefinition): void {
		this.tasks.push(task);
	}

	addHttpRoute(route: PluginHttpRoute): void {
		this.routes.push(route);
	}

	enqueueJob(pluginId: string, name: string, data: unknown): Promise<PluginJobHandle> {
		this.enqueues.push({ name, data });

		return Promise.resolve({ id: `${pluginId}:${name}:1`, name });
	}

	enqueueJobs(pluginId: string, name: string): Promise<PluginJobHandle[]> {
		this.enqueues.push({ name, data: "many" });

		return Promise.resolve([{ id: `${pluginId}:${name}:1`, name }]);
	}

	subscribe(pluginId: string, event: PluginEventName, _handler: PluginEventHandlerErased): void {
		this.subscriptions.push({ pluginId, event });
	}

	subscribeBeforeArtifactCreate(_pluginId: string, _handler: BeforeArtifactCreateHook): void {
		this.hooks.push("artifact");
	}

	subscribeBeforeMediaRecognition(_pluginId: string, _handler: BeforeMediaRecognitionHook): void {
		this.hooks.push("recognition");
	}

	subscribeBeforeMetadataSave(_pluginId: string, _handler: BeforeMetadataSaveHook): void {
		this.hooks.push("metadata");
	}

	subscribeAccessPolicy(_pluginId: string, policy: PluginAccessPolicy): void {
		this.policies.push(policy);
	}
}

describe("createPluginHost", () => {
	let activeStubs: Array<{ restore(): void }> = [];
	let broadcastStub: { calls: unknown[][]; restore(): void };
	let scope: ScopeSpy;
	let host: ReturnType<typeof createPluginHost>;

	beforeEach(async () => {
		activeStubs = [];
		const { pluginMediaService } = await import("../../capabilities/plugin.media");
		const { pluginMetadataService } = await import("../../capabilities/plugin.metadata");
		const { pluginArtifactsService } = await import("../../capabilities/plugin.artifacts");
		const { pluginFfmpegService } = await import("../../capabilities/plugin.ffmpeg");
		const { notificationsService } = await import("@/application/notifications/notifications.service");
		const { realtimeService } = await import("@/modules/realtime");
		broadcastStub = stubMethod(realtimeService, "broadcast", (type: string) => type);
		activeStubs.push(
			stubMethod(pluginMediaService, "get", (mediaFileId: string) => ({ id: mediaFileId })),
			stubMethod(pluginMetadataService, "findByExternalId", () => null),
			stubMethod(pluginArtifactsService, "write", (pluginId: string, artifact: { kind: string }) => ({ pluginId, kind: artifact.kind })),
			stubMethod(pluginFfmpegService, "extractFrame", () => ({ data: new Uint8Array() })),
			stubMethod(notificationsService, "create", (input: { title: string }, meta: { sourcePluginId: string }) => ({
				title: input.title,
				source: meta.sourcePluginId,
			})),
			broadcastStub,
		);

		const pluginLogger: PluginHost["logger"] = {
			trace: () => undefined,
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
			fatal: () => undefined,
			child: () => pluginLogger,
			time: () => () => undefined,
		};
		const pluginConfig: PluginHost["config"] = {};
		scope = new ScopeSpy();
		host = createPluginHost("org.reelvault.hosted", pluginLogger, pluginConfig, scope);
	});

	afterEach(() => {
		for (const stub of activeStubs.splice(0)) stub.restore();
	});

	test("media and metadata reads require their read capability and delegate", async () => {
		await expect(host.media.get("file-1")).resolves.toMatchObject({ id: "file-1" });
		await expect(host.metadata.findByExternalId("tmdb", "42", "movie")).resolves.toBeNull();
		expect(scope.used).toEqual(["mediaRead", "metadataRead"]);
	});

	test("registration capabilities gate and forward into the scope", async () => {
		const provider: MetadataProvider = {
			id: "p",
			name: "P",
			version: "1.0.0",
			initialize: async () => undefined,
			search: async () => [],
			getDetails: async () => null,
			getSeasonDetails: async () => null,
			getEpisodeDetails: async () => null,
		};
		await host.providers.register(provider);
		await host.subtitles.register({
			id: "s",
			name: "S",
			version: "1.0.0",
			initialize: async () => undefined,
			search: async () => [],
			download: async () => null,
		});
		await host.media.registerAnalyzer({ id: "a", name: "A", version: "1.0.0", analyze: () => ({}) });
		await host.jobs.register({ name: "refresh", handler: () => undefined });
		await host.tasks.register({ id: "t", name: "t", description: "t", defaultTriggers: [], run: async () => undefined });
		await host.routes.register({ method: "GET", path: "/p", handler: async () => ({ body: null }) });

		expect(scope.used).toEqual(["metadataProvider", "subtitleProvider", "mediaAnalyzer", "jobs", "jobs", "httpRoute"]);
		expect(scope.providers.map((entry) => entry.id)).toEqual(["p"]);
		expect(scope.subtitleProviders.map((entry) => entry.id)).toEqual(["s"]);
		expect(scope.analyzers.map((entry) => entry.id)).toEqual(["a"]);
		expect(scope.jobs.map((entry) => entry.name)).toEqual(["refresh"]);
		expect(scope.tasks.map((entry) => entry.id)).toEqual(["t"]);
		expect(scope.routes).toHaveLength(1);
	});

	test("enqueues go through the scope so unregistered names are rejected by it", async () => {
		await host.jobs.enqueue("refresh", { id: 1 });
		await host.jobs.enqueueMany("refresh", [{ data: {} }]);

		expect(scope.enqueues).toEqual([
			{ name: "refresh", data: { id: 1 } },
			{ name: "refresh", data: "many" },
		]);
	});

	test("write capabilities carry plugin attribution", async () => {
		const artifact: PlaybackArtifactWrite = {
			mediaFileId: "file-1",
			kind: "trickplay",
			contentType: "image/webp",
			content: new Uint8Array(),
		};
		await expect(host.artifacts.write(artifact)).resolves.toMatchObject({
			pluginId: "org.reelvault.hosted",
			kind: "trickplay",
		});
		await expect(host.notifications.create({ userId: "u1", type: "info", title: "Hello" })).resolves.toBeUndefined();
		expect(scope.used).toEqual(["artifactsWrite", "notification"]);
	});

	test("events, hooks, and access policies subscribe through the scope", () => {
		host.events.on("plugin.enabled", () => undefined);
		host.hooks.beforeMetadataSave(() => undefined);
		host.hooks.beforeArtifactCreate(() => undefined);
		host.hooks.beforeMediaRecognition(() => undefined);
		const policy: PluginAccessPolicy = { id: "policy-1", beforeAccess: () => undefined };
		host.access.register(policy);

		expect(scope.subscriptions).toEqual([{ pluginId: "org.reelvault.hosted", event: "plugin.enabled" }]);
		expect(scope.hooks).toEqual(["metadata", "artifact", "recognition"]);
		expect(scope.policies).toHaveLength(1);
		expect(scope.used.every((capability) => capability === "eventHandler" || capability === "accessPolicy")).toBe(true);
	});

	test("realtime broadcasts are namespaced per plugin and gated", () => {
		host.realtime.broadcast("progress", { step: 1 });

		expect(scope.used).toEqual(["eventHandler"]);
		expect(broadcastStub.calls[0]?.[0]).toBe("plugin:org.reelvault.hosted:progress");
	});

	test("http fetch is capability-gated before the guarded fetch rejects a bad URL", async () => {
		await expect(host.http.fetch("ftp://example.invalid/file")).rejects.toThrow();
		expect(scope.used).toEqual(["httpFetch"]);
	});
});
