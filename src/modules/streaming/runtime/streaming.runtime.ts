import { liveSessionsRepository } from "@/database/repositories/live-sessions.repository";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { toMap } from "@/utils/array.utils";
import { workerService } from "@/workers/worker.service";
import { playlistService } from "../playlist/playlist.service";
import { streamingManager } from "./streaming.manager";

let lifecycleRegistered = false;

/**
 * Configures the streaming manager lifecycle callbacks once, at boot. Callback
 * bodies dereference their imports lazily, so this module can never hit a TDZ
 * in an import cycle.
 */
export function registerStreamingLifecycle(): void {
	if (lifecycleRegistered) return;

	lifecycleRegistered = true;
	streamingManager.configureLifecycleCallbacks({
		cancelOperation: async (operationId) => await workerService.cancelOperation(operationId),
		onSessionStarted: ({ sessionId, mediaFileId, profileId }) => {
			pluginEventBus.publish("playback.session.started", { sessionId, mediaFileId });
			// Per-session/per-profile, not a global broadcast — other users must
			// not receive session ids or media ids.
			realtimeService.sendToProfile(profileId, "playback:session:started", { sessionId, mediaFileId });
		},
		onSessionEnded: ({ sessionId, mediaFileId, profileId, reason }) => {
			pluginEventBus.publish("playback.session.ended", { sessionId, mediaFileId, reason });
			pluginEventBus.publish("playback.lifecycle.stopped", {
				sessionId,
				mediaFileId,
				reason,
				stoppedAt: new Date().toISOString(),
			});
			realtimeService.sendToProfile(profileId, "playback:session:ended", { sessionId, mediaFileId, reason });
			realtimeService.dropPlaybackSession(sessionId);
			playlistService.invalidate(sessionId);
		},
	});
}

/** Active playback sessions owned by one profile, with media titles (remote-control page). */
export async function listMinePlaybackSessions(profileId: string | undefined) {
	if (!profileId) return { sessions: [] };

	const sessions = streamingManager.listSessionsForProfile(profileId);
	if (sessions.length === 0) return { sessions: [] };

	const mediaSummaries = await liveSessionsRepository.findMediaSummaries(sessions.map((session) => session.mediaFileId));
	const mediaMap = toMap(mediaSummaries, (media) => media.mediaFileId);

	return {
		sessions: sessions.map((session) => {
			const media = mediaMap.get(session.mediaFileId);

			return {
				...session,
				title: media?.title ?? null,
				type: media?.type ?? null,
				posterImageId: media?.posterImageId ?? null,
				posterImageUpdatedAt: media?.posterImageUpdatedAt ?? null,
			};
		}),
	};
}
