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

type SessionEventBus = Pick<typeof pluginEventBus, "publish">;

/** Publishes `playback.lifecycle.started` onto the plugin event bus; the bus is injectable for tests. */
export function publishSessionStarted(event: PlaybackSessionStartedEvent, bus: SessionEventBus = pluginEventBus): void {
	bus.publish("playback.lifecycle.started", event);
}
