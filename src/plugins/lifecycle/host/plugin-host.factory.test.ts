import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlaybackArtifactWrite } from "@reelvault/sdk/common";
import type {
	MediaAnalyzer,
	MetadataProvider,
	PluginAccessPolicy,
	PluginCapabilityName,
	PluginEventName,
	PluginHost,
	PluginHttpRoute,
	PluginJobDefinition,
	PluginJobHandle,
	PluginNotificationChannel,
	PluginScheduledTaskDefinition,
	SubtitleProvider,
} from "@reelvault/sdk/plugin";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { createProvider, createSubtitleProvider } from "@/plugins/lifecycle/plugin-entities.fixture";
import { dispatchNotificationToChannels, registerNotificationChannel } from "@/plugins/runtime/notification-channel.registry";
import type { PluginHookName } from "@/system/extensions/plugin.hooks";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { insertUsers, selectNotifications } from "../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import type { PluginEventHandlerErased, PluginScopeApi } from "./plugin.scope";
import { createPluginHost } from "./plugin-host.factory";

// Media, metadata, artifacts and notifications run against the migrated test database, so
// each capability reads or writes real rows. Stubbed: the realtime broadcast, which leaves
// the process (its payload is the assertion). The scope is a recorder of capability use:
// the gating of each capability is what these tests check.
const db = useTestDatabase();

class ScopeSpy implements PluginScopeApi {
	private readonly channelUnregisters: Array<() => void> = [];

	registerNotificationChannelScope(channel: PluginNotificationChannel): void {
		// Register into the real in-process registry so a test can observe delivery.
		this.channelUnregisters.push(registerNotificationChannel("org.reelvault.hosted", channel));
	}

	cleanupNotificationChannels(): void {
		for (const unregister of this.channelUnregisters.splice(0).toReversed()) unregister();
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

	subscribeHook(_pluginId: string, name: PluginHookName): void {
		this.hooks.push(name);
	}

	subscribeAccessPolicy(_pluginId: string, policy: PluginAccessPolicy): void {
		this.policies.push(policy);
	}
}

let activeStubs: Array<{ restore(): void }> = [];
let broadcastStub: { calls: unknown[][]; restore(): void };
let sendToUserStub: MethodStub;
let sendToProfileStub: MethodStub;
let sendToSessionStub: MethodStub;
let scope: ScopeSpy;
let host: ReturnType<typeof createPluginHost>;

function useHostFixtures(): void {
	beforeEach(() => {
		activeStubs = [];
		broadcastStub = stubMethod(realtimeService, "broadcast", (type: string) => type);
		sendToUserStub = stubMethod(realtimeService, "sendToUser", () => undefined);
		sendToProfileStub = stubMethod(realtimeService, "sendToProfile", () => undefined);
		sendToSessionStub = stubMethod(realtimeService, "sendToSession", () => undefined);
		activeStubs.push(broadcastStub, sendToUserStub, sendToProfileStub, sendToSessionStub);

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
		scope.cleanupNotificationChannels();
		for (const stub of activeStubs.splice(0).toReversed()) stub.restore();
	});
}

describe("createPluginHost", () => {
	useHostFixtures();

	test("media and metadata reads require their read capability and read the stored rows", async () => {
		const mediaFileId = await insertMovieMediaFile(db.client(), "/media/Hosted (2020)/hosted.mkv", "m-hosted");

		await expect(host.media.get(mediaFileId)).resolves.toMatchObject({ id: mediaFileId });
		await expect(host.metadata.findByExternalId("tmdb", "42", "movie")).resolves.toBeNull();
		expect(scope.used).toEqual(["mediaRead", "metadataRead"]);
	});

	test("registration capabilities gate and forward into the scope", async () => {
		await host.providers.register(createProvider("p"));
		await host.subtitles.register(createSubtitleProvider("s"));
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

	test("a notification created through the host is stored for the user and attributed to the plugin", async () => {
		await insertUsers(db.client(), { id: "user-1", name: "Ann", email: "ann@example.com", emailVerified: true });

		await host.notifications.create({ userId: "user-1", type: "info", title: "Hello" });

		expect(await selectNotifications(db.client())).toMatchObject([
			{ userId: "user-1", type: "info", title: "Hello", sourcePluginId: "org.reelvault.hosted" },
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
		expect(scope.hooks).toEqual(["beforeMetadataSave", "beforeArtifactCreate", "beforeMediaRecognition"]);
		expect(scope.policies).toHaveLength(1);
		expect(scope.used.every((capability) => capability === "eventHandler" || capability === "accessPolicy")).toBe(true);
	});

	test("realtime broadcasts are namespaced per plugin and gated", () => {
		host.realtime.broadcast("progress", { step: 1 });

		expect(scope.used).toEqual(["eventHandler"]);
		expect(broadcastStub.calls[0]?.[0]).toBe("plugin:org.reelvault.hosted:progress");
	});

	test("realtime user, profile and session events are namespaced per plugin", () => {
		host.realtime.sendToUser("user-1", "progress", { step: 2 });
		host.realtime.sendToProfile("profile-1", "progress", { step: 3 });
		host.realtime.sendToSession("session-1", "progress", { step: 4 });

		expect(sendToUserStub.calls[0]?.[1]).toBe("plugin:org.reelvault.hosted:progress");
		expect(sendToProfileStub.calls[0]?.[1]).toBe("plugin:org.reelvault.hosted:progress");
		expect(sendToSessionStub.calls[0]?.[1]).toBe("plugin:org.reelvault.hosted:progress");
	});

	test("a notification channel registered through the host receives dispatched notifications", async () => {
		const delivered: string[] = [];
		const channel: PluginNotificationChannel = {
			id: "hosted-channel",
			deliver: (notification) => {
				delivered.push(notification.title);

				return Promise.resolve();
			},
		};

		await host.notificationChannels.register(channel);
		await dispatchNotificationToChannels({ id: "n-hosted", userId: "user-1", type: "info", title: "Plugin delivery" });

		expect(delivered).toEqual(["Plugin delivery"]);
	});

	test("http fetch is capability-gated before the guarded fetch rejects a non-http URL", async () => {
		await expect(host.http.fetch("ftp://example.invalid/file")).rejects.toMatchObject({
			category: "validation",
			code: "download.unsupported_protocol",
		});
		expect(scope.used).toEqual(["httpFetch"]);
	});
});
