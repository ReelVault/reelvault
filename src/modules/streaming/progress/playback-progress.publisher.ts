import { realtimeService as defaultRealtimeService } from "@/modules/realtime/realtime.service";
import { pluginEventBus as defaultPluginEventBus } from "@/plugins/runtime/plugin.events";
import { computeProgressPercent } from "../utils/playback-position.utils";

export interface PlaybackProgressUpdateEvent {
	profileId: string;
	mediaFileId: string;
	position: number;
	duration: number;
	completed: boolean;
	audioStreamIndex?: number | null | undefined;
	subtitleId?: string | null | undefined;
}

export interface PublisherDependencies {
	pluginEventBus: Pick<typeof defaultPluginEventBus, "publish">;
	realtimeService: Pick<typeof defaultRealtimeService, "sendToProfile">;
}

const defaultDependencies: PublisherDependencies = { pluginEventBus: defaultPluginEventBus, realtimeService: defaultRealtimeService };

export class PlaybackProgressPublisher {
	private readonly dependencies: PublisherDependencies;

	constructor(dependencies: PublisherDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	publishUpdate(event: PlaybackProgressUpdateEvent): void {
		const { pluginEventBus, realtimeService } = this.dependencies;
		const { profileId, mediaFileId, position, duration, completed, audioStreamIndex, subtitleId } = event;

		pluginEventBus.publish("playback.progress.updated", {
			profileId,
			mediaFileId,
			position,
			duration,
			completed,
			audioStreamIndex,
			subtitleId,
		});

		pluginEventBus.publish("playback.lifecycle.progress", {
			profileId,
			mediaFileId,
			position,
			duration,
			progressPercent: computeProgressPercent(position, duration),
			audioStreamIndex,
			subtitleId,
			updatedAt: new Date().toISOString(),
		});

		realtimeService.sendToProfile(profileId, "playback:progress:updated", {
			mediaFileId,
			position,
			duration,
			completed,
			audioStreamIndex,
			subtitleId,
		});
	}
}
