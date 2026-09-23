import type { PlaybackDecision } from "@sdk/common/stream.types";
import { pluginsService } from "@/application/plugins.service";

export interface PlaybackSessionStartedEvent {
	sessionId: string;
	userId?: string | undefined;
	profileId: string;
	mediaFileId: string;
	mode: PlaybackDecision["mode"];
	videoCodec: string | null;
	audioCodec: string | null;
	videoBitrateKbps: number | null;
	audioStreamIndex: number | null;
	startedAt: string;
}

interface PublisherDependencies {
	pluginsService: Pick<typeof pluginsService, "publish">;
}

const defaultDependencies: PublisherDependencies = { pluginsService };

export class SessionLifecyclePublisher {
	private readonly dependencies: PublisherDependencies;

	constructor(dependencies: PublisherDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	publishStarted(event: PlaybackSessionStartedEvent): void {
		this.dependencies.pluginsService.publish("playback.lifecycle.started", event);
	}
}
