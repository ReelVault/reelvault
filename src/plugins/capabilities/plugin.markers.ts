import type { CreateMediaMarker, MediaMarker } from "@reelvault/sdk/common";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/database/repositories/media-markers.repository";
import { toPublicMarker } from "@/database/utils/media-marker.mapper";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { BaseService } from "@/utils/base-service";
import { NotFoundError } from "@/utils/errors";

class PluginMarkersService extends BaseService {
	constructor() {
		super("PluginMarkersService");
	}

	async list(pluginId: string, mediaFileId: string): Promise<MediaMarker[]> {
		// Scoped to the calling plugin: a plugin must not observe other plugins'
		// or manually created markers (set/clear are scoped the same way).
		const markers = await mediaMarkersRepository.findByMediaFileIdAndPlugin(mediaFileId, pluginId);

		return markers.map((item) => toPublicMarker(item));
	}

	async setMarkers(pluginId: string, mediaFileId: string, markers: readonly CreateMediaMarker[]): Promise<MediaMarker[]> {
		const mediaFileExists = await mediaRepository.isExists({ primaryId: mediaFileId });
		if (!mediaFileExists) throw new NotFoundError(`Media file ${mediaFileId} was not found`);

		const saved = await mediaMarkersRepository.replaceMarkersForMediaFile(mediaFileId, markers, {
			pluginId,
			source: "plugin",
		});

		const publicMarkers = saved.map((item) => toPublicMarker(item));

		pluginEventBus.publish("media.markers.updated", {
			mediaFileId,
			markerCount: publicMarkers.length,
		});

		return publicMarkers;
	}

	async clearMarkers(pluginId: string, mediaFileId: string): Promise<void> {
		// Clear only the calling plugin's markers — other plugins' and manually
		// created markers must survive (scoped replace, same as setMarkers).
		await mediaMarkersRepository.replaceMarkersForMediaFile(mediaFileId, [], { pluginId, source: "plugin" });
		pluginEventBus.publish("media.markers.updated", {
			mediaFileId,
			markerCount: 0,
		});
	}
}

export const pluginMarkersService = new PluginMarkersService();
