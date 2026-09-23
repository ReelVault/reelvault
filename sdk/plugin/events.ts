export interface PluginEventEnvelope {
	eventId: string;
	payloadVersion: 1;
	occurredAt: string;
	correlationId: string;
}

export interface PluginEventDataMap {
	"plugin.enabled": { pluginId: string };
	"plugin.disabled": { pluginId: string };
	"library.scan.started": { libraryId: string; scanId: string };
	"library.scan.completed": { libraryId: string; scanId: string; errors: number };
	"media.file.discovered": { libraryId: string; mediaFileId: string };
	"media.file.ready": { libraryId: string; mediaFileId: string; metadataId: string };
	"media.file.unavailable": { libraryId: string; mediaFileId: string };
	"metadata.search.requested": { type: "movie" | "tv_show"; title: string; year?: number | undefined };
	"metadata.saved": { metadataId: string };
	"metadata.refreshed": { metadataId: string };
	"artifact.created": { mediaFileId: string; artifactId: string; artifactType: string };
	"notification.created": {
		notificationId: string;
		userId: string;
		profileId?: string | undefined;
		type: string;
		sourcePluginId?: string | null | undefined;
	};
	"playback.session.started": { sessionId: string; mediaFileId: string };
	"playback.session.ended": { sessionId: string; mediaFileId: string; reason?: string | undefined };
	"playback.lifecycle.started": {
		sessionId: string;
		userId?: string | undefined;
		profileId: string;
		mediaFileId: string;
		mode: "direct-stream" | "transcode";
		videoCodec: string | null;
		audioCodec: string | null;
		videoBitrateKbps: number | null;
		audioStreamIndex: number | null;
		startedAt: string;
	};
	"playback.lifecycle.progress": {
		profileId: string;
		mediaFileId: string;
		position: number;
		duration: number;
		progressPercent: number;
		audioStreamIndex?: number | null | undefined;
		subtitleId?: string | null | undefined;
		updatedAt: string;
	};
	"playback.lifecycle.stopped": {
		sessionId: string;
		mediaFileId: string;
		reason: string;
		stoppedAt: string;
	};
	"playback.progress.updated": {
		profileId: string;
		mediaFileId: string;
		position: number;
		duration: number;
		completed: boolean;
		audioStreamIndex?: number | null | undefined;
		subtitleId?: string | null | undefined;
	};
	"media.file.identified": { mediaFileId: string; metadataId: string; status: "matched" | "unmatched" | "ignored" };
	"media.file.technical-data-updated": { mediaFileId: string; size: number; sourceMtimeMs: number; audioChanged: boolean };
	"media.markers.updated": { mediaFileId: string; markerCount: number };
}

export type PluginEventName = keyof PluginEventDataMap;

export type PluginEventPayload<TEvent extends PluginEventName> = PluginEventEnvelope & PluginEventDataMap[TEvent];

export type PluginEventMap = { [TEvent in PluginEventName]: PluginEventPayload<TEvent> };

export type PluginEventInput<TEvent extends PluginEventName> = PluginEventDataMap[TEvent] & { correlationId?: string | undefined };

export type PluginEventHandler<TEvent extends PluginEventName> = (payload: Readonly<PluginEventPayload<TEvent>>) => void | Promise<void>;

export interface PluginEvents {
	on<TEvent extends PluginEventName>(event: TEvent, handler: PluginEventHandler<TEvent>): void;
}

export function createPluginEventPayload<TEvent extends PluginEventName>(
	payload: PluginEventInput<TEvent>,
	now = new Date(),
): PluginEventPayload<TEvent> {
	const envelope: PluginEventEnvelope = {
		eventId: crypto.randomUUID(),
		payloadVersion: 1,
		occurredAt: now.toISOString(),
		correlationId: payload.correlationId ?? crypto.randomUUID(),
	};
	const combined = { ...payload, ...envelope };
	Object.freeze(combined);

	return combined;
}
