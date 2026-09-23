import type { MetadataProviderConfiguration, MetadataProviderSearchRequest, PluginMediaFile } from "@sdk/common";
import type { MediaAnalysis, PluginEventInput, PluginEventName, PluginStatus } from "@sdk/plugin";
import { pluginArtifactsService } from "@/plugins/capabilities/plugin.artifacts";
import { pluginMediaService } from "@/plugins/capabilities/plugin.media";
import { providerService } from "@/plugins/capabilities/provider.service";
import { subtitleProviderService } from "@/plugins/capabilities/subtitle-provider.service";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { pluginAccessBus } from "@/plugins/runtime/plugin.access";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { pluginHookBus } from "@/plugins/runtime/plugin.hooks";
import {
	type PluginRouteDispatchInput,
	type PluginRouteDispatchResult,
	pluginRouteDispatchService,
} from "@/plugins/runtime/plugin-route-dispatch.service";
import { BaseService } from "@/utils/base-service";

class PluginsService extends BaseService {
	constructor() {
		super("PluginsService");
	}

	checkAccess(input: Parameters<typeof pluginAccessBus.check>[0]) {
		return pluginAccessBus.check(input);
	}

	async load(): Promise<void> {
		await pluginManager.loadPlugins();
	}

	async shutdown(): Promise<void> {
		await pluginManager.shutdown();
	}

	async reloadAll(): Promise<PluginStatus[]> {
		await pluginManager.reloadAll();

		return pluginManager.getStatus();
	}

	async reload(pluginId: string): Promise<PluginStatus | undefined> {
		try {
			await pluginManager.reload(pluginId);
		} catch {
			// Reloading may fail again; the recorded state is returned below.
		}

		return this.get(pluginId);
	}

	async enable(pluginId: string): Promise<PluginStatus | undefined> {
		try {
			await pluginManager.setEnabled(pluginId, true);
		} catch {
			// Enabling may fail; the recorded state is returned below.
		}

		return this.get(pluginId);
	}

	async disable(pluginId: string): Promise<PluginStatus | undefined> {
		try {
			await pluginManager.setEnabled(pluginId, false);
		} catch {
			// Disabling may fail; the recorded state is returned below.
		}

		return this.get(pluginId);
	}

	get(pluginId: string): PluginStatus | undefined {
		return pluginManager.getStatus().find((plugin) => plugin.id === pluginId);
	}

	getStatus(): PluginStatus[] {
		return pluginManager.getStatus();
	}

	getSubtitleProviderStatus() {
		return pluginManager.getSubtitleProviderStatus();
	}

	getConfig(pluginName: string): Promise<Record<string, unknown>> {
		return pluginManager.getConfig(pluginName);
	}

	getConfigDetails(pluginId: string) {
		return pluginManager.getPluginConfigDetails(pluginId);
	}

	saveConfig(pluginId: string, updatedConfig: Record<string, unknown>) {
		return pluginManager.savePluginConfig(pluginId, updatedConfig);
	}

	analyzeMedia(media: PluginMediaFile): Promise<MediaAnalysis> {
		return pluginRegistry.analyzeMedia(media);
	}

	publish<TEvent extends PluginEventName>(event: TEvent, payload: PluginEventInput<TEvent>): void {
		pluginEventBus.publish(event, payload);
	}

	emit<TEvent extends PluginEventName>(event: TEvent, payload: PluginEventInput<TEvent>): Promise<void> {
		return pluginEventBus.emit(event, payload);
	}

	fetchProviderImages(...input: Parameters<typeof providerService.fetchImagesByProvider>) {
		return providerService.fetchImagesByProvider(...input);
	}

	fetchProviderDetails(...input: Parameters<typeof providerService.fetchDetails>) {
		return providerService.fetchDetails(...input);
	}

	fetchProviderDetailsAggregated(...input: Parameters<typeof providerService.fetchAggregatedDetails>) {
		return providerService.fetchAggregatedDetails(...input);
	}

	fetchProviderDetailsByLocalIdentifiers(...input: Parameters<typeof providerService.fetchDetailsByLocalIdentifiers>) {
		return providerService.fetchDetailsByLocalIdentifiers(...input);
	}

	fetchProviderDetailsByProvider(...input: Parameters<typeof providerService.fetchDetailsByProvider>) {
		return providerService.fetchDetailsByProvider(...input);
	}

	fetchProviderSeasonFromLinks(...input: Parameters<typeof providerService.fetchSeasonFromLinks>) {
		return providerService.fetchSeasonFromLinks(...input);
	}

	fetchProviderEpisodeFromLinks(...input: Parameters<typeof providerService.fetchEpisodeFromLinks>) {
		return providerService.fetchEpisodeFromLinks(...input);
	}

	fetchProviderPerson(...input: Parameters<typeof providerService.fetchPerson>) {
		return providerService.fetchPerson(...input);
	}

	transformMetadataCandidate(...input: Parameters<typeof pluginHookBus.runBeforeMetadataSave>) {
		return pluginHookBus.runBeforeMetadataSave(...input);
	}

	transformRecognitionCandidate(...input: Parameters<typeof pluginHookBus.runBeforeMediaRecognition>) {
		return pluginHookBus.runBeforeMediaRecognition(...input);
	}

	listArtifacts(...input: Parameters<typeof pluginArtifactsService.list>) {
		return pluginArtifactsService.list(...input);
	}

	findArtifactFile(...input: Parameters<typeof pluginArtifactsService.findFile>) {
		return pluginArtifactsService.findFile(...input);
	}

	removeArtifactStorageFiles(...input: Parameters<typeof pluginArtifactsService.removeStorageFiles>) {
		return pluginArtifactsService.removeStorageFiles(...input);
	}

	getPublicMedia(...input: Parameters<typeof pluginMediaService.get>) {
		return pluginMediaService.get(...input);
	}

	searchSubtitleProviders(...input: Parameters<typeof subtitleProviderService.search>) {
		return subtitleProviderService.search(...input);
	}

	downloadSubtitleFromProvider(...input: Parameters<typeof subtitleProviderService.download>) {
		return subtitleProviderService.download(...input);
	}

	getSubtitleContent(...input: Parameters<typeof subtitleProviderService.getContent>) {
		return subtitleProviderService.getContent(...input);
	}

	dispatchRoute(input: PluginRouteDispatchInput): Promise<PluginRouteDispatchResult> {
		return pluginRouteDispatchService.dispatch(input);
	}

	getProviderStatus() {
		return providerService.getAll();
	}

	searchProviders(body: MetadataProviderSearchRequest) {
		return providerService.search(body);
	}

	getProviderConfigurations(): Promise<MetadataProviderConfiguration[]> {
		return providerService.getConfigurations();
	}

	updateProviderConfiguration(
		providerId: string,
		values: { priority?: number; enabled?: boolean },
	): Promise<MetadataProviderConfiguration> {
		return providerService.updateConfiguration(providerId, values);
	}

	reorderProviderConfigurations(providerIds: readonly string[]): Promise<MetadataProviderConfiguration[]> {
		return providerService.reorderConfigurations(providerIds);
	}
}

export const pluginsService = new PluginsService();
