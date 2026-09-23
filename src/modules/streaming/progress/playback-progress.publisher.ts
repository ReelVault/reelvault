import { pluginsService as defaultPluginsService } from "@/application/plugins.service";
import { realtimeService as defaultRealtimeService } from "@/modules/realtime";
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
	pluginsService: Pick<typeof defaultPluginsService, "publish">;
	realtimeService: Pick<typeof defaultRealtimeService, "sendToProfile">;
}

const defaultDependencies: PublisherDependencies = { pluginsService: defaultPluginsService, realtimeService: defaultRealtimeService };

export class PlaybackProgressPublisher {
	private readonly dependencies: PublisherDependencies;

	constructor(dependencies: PublisherDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	publishUpdate(event: PlaybackProgressUpdateEvent): void {
		const { pluginsService, realtimeService } = this.dependencies;
		const { profileId, mediaFileId, position, duration, completed, audioStreamIndex, subtitleId } = event;

		pluginsService.publish("playback.progress.updated", {
			profileId,
			mediaFileId,
			position,
			duration,
			completed,
			audioStreamIndex,
			subtitleId,
		});

		pluginsService.publish("playback.lifecycle.progress", {
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
