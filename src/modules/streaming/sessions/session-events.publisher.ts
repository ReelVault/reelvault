import type { PlaybackDecision } from "@reelvault/sdk/common";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";

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
	pluginEventBus: Pick<typeof pluginEventBus, "publish">;
}

const defaultDependencies: PublisherDependencies = { pluginEventBus };

export class SessionLifecyclePublisher {
	private readonly dependencies: PublisherDependencies;

	constructor(dependencies: PublisherDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	publishStarted(event: PlaybackSessionStartedEvent): void {
		this.dependencies.pluginEventBus.publish("playback.lifecycle.started", event);
	}
}
