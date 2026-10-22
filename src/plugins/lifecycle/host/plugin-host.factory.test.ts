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
import { realtimeService } from "@/modules/realtime/realtime.service";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import type { PluginEventHandlerErased, PluginScopeApi } from "./plugin.scope";
import { createPluginHost, type PluginNotificationSink, registerPluginNotificationSink } from "./plugin-host.factory";

// Media, metadata, artifacts and notifications run against the migrated test database, so
// each capability reads or writes real rows. Stubbed: the realtime broadcast, which leaves
// the process (its payload is the assertion). The scope is a recorder of capability use:
// the gating of each capability is what these tests check.
const db = useTestDatabase();

class ScopeSpy implements PluginScopeApi {
	registerNotificationChannelScope(): void {
		// Channels are covered by the dedicated registry test.
	}
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

	enqueueJob(pluginId: string, name: string): Promise<PluginJobHandle> {
		return Promise.resolve({ id: `${pluginId}:${name}:1`, name });
	}

	enqueueJobs(pluginId: string, name: string): Promise<PluginJobHandle[]> {
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

let activeStubs: Array<{ restore(): void }> = [];
let broadcastStub: { calls: unknown[][]; restore(): void };
let scope: ScopeSpy;
let host: ReturnType<typeof createPluginHost>;

function useHostFixtures(): void {
	beforeEach(() => {
		activeStubs = [];
		broadcastStub = stubMethod(realtimeService, "broadcast", (type: string) => type);
		activeStubs.push(broadcastStub);

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
		for (const stub of activeStubs.splice(0).toReversed()) stub.restore();
	});
}

describe("createPluginHost", () => {
	let createdNotifications: Array<Parameters<PluginNotificationSink["create"]>> = [];

	beforeEach(() => {
		createdNotifications = [];
		registerPluginNotificationSink({
			create: (notification, options) => {
				createdNotifications.push([notification, options]);

				return Promise.resolve("notification-1");
			},
			createForAdministrators: () => Promise.resolve(),
		});
	});

	useHostFixtures();

	test("media and metadata reads require their read capability and read the stored rows", async () => {
		const mediaFileId = await insertMovieMediaFile(db.client(), "/media/Hosted (2020)/hosted.mkv", "m-hosted");

		await expect(host.media.get(mediaFileId)).resolves.toMatchObject({ id: mediaFileId });
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

	test("an artifact written through the host is stored under the plugin's id", async () => {
		const mediaFileId = await insertMovieMediaFile(db.client(), "/media/Hosted (2020)/hosted.mkv", "m-artifact");
		const artifact: PlaybackArtifactWrite = {
			mediaFileId,
			kind: "trickplay",
			contentType: "image/webp",
			content: new Uint8Array([1, 2, 3]),
		};

		await expect(host.artifacts.write(artifact)).resolves.toMatchObject({
			mediaFileId,
			pluginId: "org.reelvault.hosted",
			kind: "trickplay",
		});
		expect(scope.used).toEqual(["artifactsWrite"]);
	});

	test("a notification created through the host reaches the sink attributed to the plugin", async () => {
		await expect(host.notifications.create({ userId: "user-1", type: "info", title: "Hello" })).resolves.toBeUndefined();

		expect(createdNotifications).toEqual([
			[expect.objectContaining({ userId: "user-1", title: "Hello" }), { sourcePluginId: "org.reelvault.hosted" }],
		]);
		expect(scope.used).toEqual(["notification"]);
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

	test("http fetch is capability-gated before the guarded fetch rejects a non-http URL", async () => {
		await expect(host.http.fetch("ftp://example.invalid/file")).rejects.toMatchObject({
			category: "validation",
			code: "download.unsupported_protocol",
		});
		expect(scope.used).toEqual(["httpFetch"]);
	});
});
