import type { CreateMediaMarker, MediaMarker } from "@reelvault/sdk/common";
import { toPublicMarker } from "@/integrations/drizzle-orm/utils/media-marker.mapper";
import { pluginMarkerData, pluginMediaData } from "@/services/plugins/plugin-data.service";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { assertExists, DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";

export const pluginMarkersService = {
	serviceName: "PluginMarkersService",
	logger: createLogger("PluginMarkersService"),

	async list(pluginId: string, mediaFileId: string): Promise<MediaMarker[]> {
		// Scoped to the calling plugin: a plugin must not observe other plugins'
		// or manually created markers (set/clear are scoped the same way).
		const markers = await pluginMarkerData.findByMediaFileIdAndPlugin(mediaFileId, pluginId);

		return markers.map((item) => toPublicMarker(item));
	},

	async setMarkers(pluginId: string, mediaFileId: string, markers: readonly CreateMediaMarker[]): Promise<MediaMarker[]> {
		const mediaFileExists = await pluginMediaData.isExists({ primaryId: mediaFileId });
		assertExists(
			mediaFileExists,
			"Media file",
			mediaFileId,
			new DomainError("not_found", `Media file ${mediaFileId} was not found`, { code: "media_file.not_found" }),
		);

		const saved = await pluginMarkerData.replaceMarkersForMediaFile(mediaFileId, markers, {
			pluginId,
			source: "plugin",
		});

		const publicMarkers = saved.map((item) => toPublicMarker(item));

		pluginEventBus.publish("media.markers.updated", {
			mediaFileId,
			markerCount: publicMarkers.length,
		});

		return publicMarkers;
	},

	async clearMarkers(pluginId: string, mediaFileId: string): Promise<void> {
		// Clear only the calling plugin's markers — other plugins' and manually
		// created markers must survive (scoped replace, same as setMarkers).
		await pluginMarkerData.replaceMarkersForMediaFile(mediaFileId, [], { pluginId, source: "plugin" });
		pluginEventBus.publish("media.markers.updated", {
			mediaFileId,
			markerCount: 0,
		});
	},
};
