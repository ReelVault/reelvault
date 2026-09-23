import type { PluginHost } from "@sdk/plugin";
import { notificationsService } from "@/application/notifications/notifications.service";
import { realtimeService } from "@/modules/realtime";
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

function buildMediaCapability(scope: PluginScopeApi): PluginHost["media"] {
	return {
		get: async (mediaFileId) => {
			scope.useCapability("mediaRead");

			return await pluginMediaService.get(mediaFileId);
		},
		getRevision: async (mediaFileId) => {
			scope.useCapability("mediaRead");

			return await pluginMediaService.getRevision(mediaFileId);
		},
		listEpisodeFilesBySeason: async () => {
			scope.useCapability("mediaRead");

			return await pluginMediaService.listEpisodeFilesBySeason();
		},
		listAllMediaFiles: async (options) => {
			scope.useCapability("mediaRead");

			return await pluginMediaService.listAllMediaFiles(options);
		},
		registerAnalyzer: (analyzer) => {
			scope.useCapability("mediaAnalyzer");
			scope.addAnalyzer(analyzer);

			return Promise.resolve();
		},
	};
}

function buildMetadataCapability(scope: PluginScopeApi): PluginHost["metadata"] {
	return {
		get: async (metadataId) => {
			scope.useCapability("metadataRead");

			return await pluginMetadataService.get(metadataId);
		},
		findByExternalId: async (providerId, externalId, type) => {
			scope.useCapability("metadataRead");

			return await pluginMetadataService.findByExternalId(providerId, externalId, type);
		},
		findManyByExternalIds: async (providerId, externalIds, type) => {
			scope.useCapability("metadataRead");

			return await pluginMetadataService.findManyByExternalIds(providerId, externalIds, type);
		},
	};
}

function buildArtifactsCapability(pluginId: string, scope: PluginScopeApi): PluginHost["artifacts"] {
	return {
		list: async (mediaFileId) => {
			scope.useCapability("artifactsRead");

			return await pluginArtifactsService.list(mediaFileId);
		},
		write: async (artifact) => {
			scope.useCapability("artifactsWrite");

			return await pluginArtifactsService.write(pluginId, artifact);
		},
		deleteByKind: async (mediaFileId, kind) => {
			scope.useCapability("artifactsWrite");

			return await pluginArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, kind, pluginId);
		},
	};
}

function buildFfmpegCapability(scope: PluginScopeApi): PluginHost["ffmpeg"] {
	return {
		runAnalyse: async (args, options) => {
			scope.useCapability("ffmpegRun");

			return await pluginFfmpegService.runAnalyse(args, options);
		},
		extractFrame: async (request) => {
			scope.useCapability("ffmpegRun");

			return await pluginFfmpegService.extractFrame(request);
		},
		extractSprite: async (request) => {
			scope.useCapability("ffmpegRun");

			return await pluginFfmpegService.extractSprite(request);
		},
	};
}

function buildProvidersCapability(scope: PluginScopeApi): PluginHost["providers"] {
	const assertReadAccess = (): void => {
		scope.useCapability("providerAccess");
	};

	return {
		register: (provider) => {
			scope.useCapability("metadataProvider");
			scope.addProvider(provider);

			return Promise.resolve();
		},
		list: () => {
			assertReadAccess();

			return Promise.resolve(providerService.getAll());
		},
		search: async (request) => {
			assertReadAccess();

			return await providerService.searchProviders(request);
		},
		getDetails: async (providerId, type, externalId) => {
			assertReadAccess();

			return (await providerService.fetchDetailsByProvider(providerId, type, externalId)) ?? null;
		},
		getSeasonDetails: async (providerId, externalId, seasonNumber) => {
			assertReadAccess();

			return await providerService.fetchSeasonByProvider(providerId, externalId, seasonNumber);
		},
		resolveDetails: async (type, title, year) => {
			assertReadAccess();

			return await providerService.resolveDetails(type, title, year);
		},
		discover: async (request) => {
			assertReadAccess();

			return await providerService.discover(request);
		},
		getGenres: async (type, providerId) => {
			assertReadAccess();

			return await providerService.getGenres(type, providerId);
		},
	};
}

function buildSubtitlesCapability(scope: PluginScopeApi): PluginHost["subtitles"] {
	return {
		register: (provider) => {
			scope.useCapability("subtitleProvider");
			scope.addSubtitleProvider(provider);

			return Promise.resolve();
		},
	};
}

function buildJobsCapability(pluginId: string, scope: PluginScopeApi): PluginHost["jobs"] {
	return {
		register: (definition) => {
			scope.useCapability("jobs");
			scope.addJob(definition);

			return Promise.resolve();
		},
		enqueue: async (name, data, options) => {
			scope.useCapability("jobs");

			return await scope.enqueueJob(pluginId, name, data, options);
		},
		enqueueMany: async (name, items, commonOptions) => {
			scope.useCapability("jobs");

			return await scope.enqueueJobs(pluginId, name, items, commonOptions);
		},
	};
}

function buildTasksCapability(scope: PluginScopeApi): PluginHost["tasks"] {
	return {
		register: (task) => {
			// Scheduled tasks execute arbitrary code on cron triggers — same trust level as job handlers.
			scope.useCapability("jobs");
			scope.addScheduledTask(task);

			return Promise.resolve();
		},
	};
}

function buildRoutesCapability(scope: PluginScopeApi): PluginHost["routes"] {
	return {
		register: (route) => {
			scope.useCapability("httpRoute");
			scope.addHttpRoute(route);

			return Promise.resolve();
		},
	};
}

function buildStorageCapability(pluginId: string, scope: PluginScopeApi): PluginHost["storage"] {
	return {
		get: async (key) => {
			scope.useCapability("storage");

			return await pluginStorageService.get(pluginId, key);
		},
		set: async (key, value) => {
			scope.useCapability("storage");
			await pluginStorageService.set(pluginId, key, value);
		},
		update: async (key, updater) => {
			scope.useCapability("storage");

			return await pluginStorageService.update(pluginId, key, updater);
		},
		delete: async (key) => {
			scope.useCapability("storage");
			await pluginStorageService.delete(pluginId, key);
		},
		putBlob: async (key, content, options) => {
			scope.useCapability("storage");

			return await pluginBlobsService.put(pluginId, key, content, options);
		},
		getBlob: async (key) => {
			scope.useCapability("storage");

			return await pluginBlobsService.get(pluginId, key);
		},
		deleteBlob: async (key) => {
			scope.useCapability("storage");
			await pluginBlobsService.delete(pluginId, key);
		},
		list: async (prefix) => {
			scope.useCapability("storage");

			return await pluginStorageService.list(pluginId, prefix);
		},
	};
}

function buildHttpCapability(scope: PluginScopeApi): PluginHost["http"] {
	return {
		fetch: async (input, init) => {
			scope.useCapability("httpFetch");

			return await guardedPluginFetch(input, init);
		},
	};
}

function buildMarkersCapability(pluginId: string, scope: PluginScopeApi): PluginHost["markers"] {
	return {
		list: async (mediaFileId) => {
			scope.useCapability("markers");

			return await pluginMarkersService.list(pluginId, mediaFileId);
		},
		set: async (mediaFileId, markers) => {
			scope.useCapability("markers");

			return await pluginMarkersService.setMarkers(pluginId, mediaFileId, markers);
		},
		clear: async (mediaFileId) => {
			scope.useCapability("markers");
			await pluginMarkersService.clearMarkers(pluginId, mediaFileId);
		},
	};
}

function buildEventsCapability(pluginId: string, scope: PluginScopeApi): PluginHost["events"] {
	return {
		on: (event, handler) => {
			scope.useCapability("eventHandler");
			scope.subscribe(pluginId, event, handler);
		},
	};
}

function buildHooksCapability(pluginId: string, scope: PluginScopeApi): PluginHost["hooks"] {
	return {
		beforeArtifactCreate: (handler) => {
			scope.useCapability("eventHandler");
			scope.subscribeBeforeArtifactCreate(pluginId, handler);
		},
		beforeMediaRecognition: (handler) => {
			scope.useCapability("eventHandler");
			scope.subscribeBeforeMediaRecognition(pluginId, handler);
		},
		beforeMetadataSave: (handler) => {
			scope.useCapability("eventHandler");
			scope.subscribeBeforeMetadataSave(pluginId, handler);
		},
	};
}

function buildAccessCapability(pluginId: string, scope: PluginScopeApi): PluginHost["access"] {
	return {
		register: (policy) => {
			scope.useCapability("accessPolicy");
			scope.subscribeAccessPolicy(pluginId, policy);
		},
	};
}

function buildNotificationsCapability(pluginId: string, scope: PluginScopeApi): PluginHost["notifications"] {
	return {
		create: async (notification) => {
			scope.useCapability("notification");
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
		},
	};
}

function buildRealtimeCapability(pluginId: string, scope: PluginScopeApi): PluginHost["realtime"] {
	return {
		broadcast: (type, payload) => {
			scope.useCapability("eventHandler");
			realtimeService.broadcast(`plugin:${pluginId}:${type}`, payload);
		},
		sendToUser: (userId, type, payload) => {
			scope.useCapability("eventHandler");
			realtimeService.sendToUser(userId, `plugin:${pluginId}:${type}`, payload);
		},
		sendToProfile: (profileId, type, payload) => {
			scope.useCapability("eventHandler");
			realtimeService.sendToProfile(profileId, `plugin:${pluginId}:${type}`, payload);
		},
		sendToSession: (sessionId, type, payload) => {
			scope.useCapability("eventHandler");
			realtimeService.sendToSession(sessionId, `plugin:${pluginId}:${type}`, payload);
		},
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
		realtime: buildRealtimeCapability(pluginId, scope),
	};
}
