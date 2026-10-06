import type { PluginCapabilityName, PluginHost } from "@reelvault/sdk/plugin";
import { notificationsService } from "@/application/notifications/notifications.service";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { pickDefined } from "@/utils/type.utils";
import { pluginArtifactsService } from "../../capabilities/plugin.artifacts";
import { pluginBlobsService } from "../../capabilities/plugin.blobs";
import { pluginFfmpegService } from "../../capabilities/plugin.ffmpeg";
import { guardedPluginFetch } from "../../capabilities/plugin.http";
import { pluginMarkersService } from "../../capabilities/plugin.markers";
import { pluginMediaService } from "../../capabilities/plugin.media";
import { pluginMetadataService } from "../../capabilities/plugin.metadata";
import { pluginStorageService } from "../../capabilities/plugin.storage";
import { providerService } from "../../capabilities/provider.service";
import type { PluginScopeApi } from "./plugin.scope";

/** Declares the capability, then runs the host action — the single gate every host method goes through. */
const withCapability = <T>(scope: PluginScopeApi, capability: PluginCapabilityName, run: () => T): T => {
	scope.useCapability(capability);

	return run();
};

function buildMediaCapability(scope: PluginScopeApi): PluginHost["media"] {
	return {
		get: async (mediaFileId) => withCapability(scope, "mediaRead", () => pluginMediaService.get(mediaFileId)),
		getRevision: async (mediaFileId) => withCapability(scope, "mediaRead", () => pluginMediaService.getRevision(mediaFileId)),
		listEpisodeFilesBySeason: async () => withCapability(scope, "mediaRead", () => pluginMediaService.listEpisodeFilesBySeason()),
		listAllMediaFiles: async (options) => withCapability(scope, "mediaRead", () => pluginMediaService.listAllMediaFiles(options)),
		registerAnalyzer: (analyzer) =>
			withCapability(scope, "mediaAnalyzer", () => {
				scope.addAnalyzer(analyzer);

				return Promise.resolve();
			}),
	};
}

function buildMetadataCapability(scope: PluginScopeApi): PluginHost["metadata"] {
	return {
		get: async (metadataId) => withCapability(scope, "metadataRead", () => pluginMetadataService.get(metadataId)),
		findByExternalId: async (providerId, externalId, type) =>
			withCapability(scope, "metadataRead", () => pluginMetadataService.findByExternalId(providerId, externalId, type)),
		findManyByExternalIds: async (providerId, externalIds, type) =>
			withCapability(scope, "metadataRead", () => pluginMetadataService.findManyByExternalIds(providerId, externalIds, type)),
	};
}

function buildArtifactsCapability(pluginId: string, scope: PluginScopeApi): PluginHost["artifacts"] {
	return {
		list: async (mediaFileId) => withCapability(scope, "artifactsRead", () => pluginArtifactsService.list(mediaFileId)),
		write: async (artifact) => withCapability(scope, "artifactsWrite", () => pluginArtifactsService.write(pluginId, artifact)),
		deleteByKind: async (mediaFileId, kind) =>
			withCapability(scope, "artifactsWrite", () => pluginArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, kind, pluginId)),
	};
}

function buildFfmpegCapability(scope: PluginScopeApi): PluginHost["ffmpeg"] {
	return {
		runAnalyse: async (args, options) => withCapability(scope, "ffmpegRun", () => pluginFfmpegService.runAnalyse(args, options)),
		extractFrame: async (request) => withCapability(scope, "ffmpegRun", () => pluginFfmpegService.extractFrame(request)),
		extractSprite: async (request) => withCapability(scope, "ffmpegRun", () => pluginFfmpegService.extractSprite(request)),
	};
}

function buildProvidersCapability(scope: PluginScopeApi): PluginHost["providers"] {
	return {
		register: (provider) =>
			withCapability(scope, "metadataProvider", () => {
				scope.addProvider(provider);

				return Promise.resolve();
			}),
		list: () => withCapability(scope, "providerAccess", () => Promise.resolve(providerService.getAll())),
		search: async (request) => withCapability(scope, "providerAccess", () => providerService.searchProviders(request)),
		getDetails: async (providerId, type, externalId) =>
			withCapability(
				scope,
				"providerAccess",
				async () => (await providerService.fetchDetailsByProvider(providerId, type, externalId)) ?? null,
			),
		getSeasonDetails: async (providerId, externalId, seasonNumber) =>
			withCapability(scope, "providerAccess", () => providerService.fetchSeasonByProvider(providerId, externalId, seasonNumber)),
		resolveDetails: async (type, title, year) =>
			withCapability(scope, "providerAccess", () => providerService.resolveDetails(type, title, year)),
		discover: async (request) => withCapability(scope, "providerAccess", () => providerService.discover(request)),
		getGenres: async (type, providerId) => withCapability(scope, "providerAccess", () => providerService.getGenres(type, providerId)),
	};
}

function buildSubtitlesCapability(scope: PluginScopeApi): PluginHost["subtitles"] {
	return {
		register: (provider) =>
			withCapability(scope, "subtitleProvider", () => {
				scope.addSubtitleProvider(provider);

				return Promise.resolve();
			}),
	};
}

function buildJobsCapability(pluginId: string, scope: PluginScopeApi): PluginHost["jobs"] {
	return {
		register: (definition) =>
			withCapability(scope, "jobs", () => {
				scope.addJob(definition);

				return Promise.resolve();
			}),
		enqueue: async (name, data, options) => withCapability(scope, "jobs", () => scope.enqueueJob(pluginId, name, data, options)),
		enqueueMany: async (name, items, commonOptions) =>
			withCapability(scope, "jobs", () => scope.enqueueJobs(pluginId, name, items, commonOptions)),
	};
}

function buildTasksCapability(scope: PluginScopeApi): PluginHost["tasks"] {
	return {
		// Scheduled tasks execute arbitrary code on cron triggers — same trust level as job handlers.
		register: (task) =>
			withCapability(scope, "jobs", () => {
				scope.addScheduledTask(task);

				return Promise.resolve();
			}),
	};
}

function buildRoutesCapability(scope: PluginScopeApi): PluginHost["routes"] {
	return {
		register: (route) =>
			withCapability(scope, "httpRoute", () => {
				scope.addHttpRoute(route);

				return Promise.resolve();
			}),
	};
}

function buildStorageCapability(pluginId: string, scope: PluginScopeApi): PluginHost["storage"] {
	return {
		get: async (key) => withCapability(scope, "storage", () => pluginStorageService.get(pluginId, key)),
		set: async (key, value) => withCapability(scope, "storage", () => pluginStorageService.set(pluginId, key, value)),
		update: async (key, updater) => withCapability(scope, "storage", () => pluginStorageService.update(pluginId, key, updater)),
		delete: async (key) => withCapability(scope, "storage", () => pluginStorageService.delete(pluginId, key)),
		putBlob: async (key, content, options) =>
			withCapability(scope, "storage", () => pluginBlobsService.put(pluginId, key, content, options)),
		getBlob: async (key) => withCapability(scope, "storage", () => pluginBlobsService.get(pluginId, key)),
		deleteBlob: async (key) => withCapability(scope, "storage", () => pluginBlobsService.delete(pluginId, key)),
		list: async (prefix) => withCapability(scope, "storage", () => pluginStorageService.list(pluginId, prefix)),
	};
}

function buildHttpCapability(scope: PluginScopeApi): PluginHost["http"] {
	return {
		fetch: async (input, init) => withCapability(scope, "httpFetch", () => guardedPluginFetch(input, init)),
	};
}

function buildMarkersCapability(pluginId: string, scope: PluginScopeApi): PluginHost["markers"] {
	return {
		list: async (mediaFileId) => withCapability(scope, "markers", () => pluginMarkersService.list(pluginId, mediaFileId)),
		set: async (mediaFileId, markers) =>
			withCapability(scope, "markers", () => pluginMarkersService.setMarkers(pluginId, mediaFileId, markers)),
		clear: async (mediaFileId) => withCapability(scope, "markers", () => pluginMarkersService.clearMarkers(pluginId, mediaFileId)),
	};
}

function buildEventsCapability(pluginId: string, scope: PluginScopeApi): PluginHost["events"] {
	return {
		on: (event, handler) => withCapability(scope, "eventHandler", () => scope.subscribe(pluginId, event, handler)),
	};
}

function buildHooksCapability(pluginId: string, scope: PluginScopeApi): PluginHost["hooks"] {
	return {
		beforeArtifactCreate: (handler) => withCapability(scope, "eventHandler", () => scope.subscribeBeforeArtifactCreate(pluginId, handler)),
		beforeMediaRecognition: (handler) =>
			withCapability(scope, "eventHandler", () => scope.subscribeBeforeMediaRecognition(pluginId, handler)),
		beforeMetadataSave: (handler) => withCapability(scope, "eventHandler", () => scope.subscribeBeforeMetadataSave(pluginId, handler)),
	};
}

function buildAccessCapability(pluginId: string, scope: PluginScopeApi): PluginHost["access"] {
	return {
		register: (policy) => withCapability(scope, "accessPolicy", () => scope.subscribeAccessPolicy(pluginId, policy)),
	};
}

function buildNotificationsCapability(pluginId: string, scope: PluginScopeApi): PluginHost["notifications"] {
	return {
		create: async (notification) =>
			withCapability(scope, "notification", async () => {
				// Attribution + quota are host-enforced; the type stays plugin-authored for FE compatibility.
				await notificationsService.create(
					{
						userId: notification.userId,
						type: notification.type,
						title: notification.title,
						...pickDefined({
							profileId: notification.profileId,
							message: notification.message,
							data: notification.data,
							link: notification.link,
						}),
					},
					{ sourcePluginId: pluginId },
				);
			}),
	};
}

function buildNotificationChannelsCapability(scope: PluginScopeApi): PluginHost["notificationChannels"] {
	return {
		register: (channel) => withCapability(scope, "notificationChannel", () => scope.registerNotificationChannelScope(channel)),
	};
}

function buildRealtimeCapability(pluginId: string, scope: PluginScopeApi): PluginHost["realtime"] {
	return {
		broadcast: (type, payload) =>
			withCapability(scope, "eventHandler", () => realtimeService.broadcast(`plugin:${pluginId}:${type}`, payload)),
		sendToUser: (userId, type, payload) =>
			withCapability(scope, "eventHandler", () => realtimeService.sendToUser(userId, `plugin:${pluginId}:${type}`, payload)),
		sendToProfile: (profileId, type, payload) =>
			withCapability(scope, "eventHandler", () => realtimeService.sendToProfile(profileId, `plugin:${pluginId}:${type}`, payload)),
		sendToSession: (sessionId, type, payload) =>
			withCapability(scope, "eventHandler", () => realtimeService.sendToSession(sessionId, `plugin:${pluginId}:${type}`, payload)),
	};
}

/** Builds the capability-scoped host object a plugin's setup() receives. */
export function createPluginHost(
	pluginId: string,
	logger: PluginHost["logger"],
	config: PluginHost["config"],
	scope: PluginScopeApi,
): PluginHost {
	return {
		logger,
		config,
		media: buildMediaCapability(scope),
		metadata: buildMetadataCapability(scope),
		artifacts: buildArtifactsCapability(pluginId, scope),
		ffmpeg: buildFfmpegCapability(scope),
		providers: buildProvidersCapability(scope),
		subtitles: buildSubtitlesCapability(scope),
		jobs: buildJobsCapability(pluginId, scope),
		tasks: buildTasksCapability(scope),
		routes: buildRoutesCapability(scope),
		storage: buildStorageCapability(pluginId, scope),
		http: buildHttpCapability(scope),
		markers: buildMarkersCapability(pluginId, scope),
		events: buildEventsCapability(pluginId, scope),
		hooks: buildHooksCapability(pluginId, scope),
		access: buildAccessCapability(pluginId, scope),
		notifications: buildNotificationsCapability(pluginId, scope),
		notificationChannels: buildNotificationChannelsCapability(scope),
		realtime: buildRealtimeCapability(pluginId, scope),
	};
}
