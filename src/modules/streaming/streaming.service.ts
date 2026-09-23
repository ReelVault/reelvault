import type {
	ContinueWatchingItem,
	CreatePlaybackSession,
	MetadataPlaybackProgress,
	PlaybackDiagnostics,
	PlaybackSession,
	StreamHeartbeatResponse,
	StreamSeekResponse,
	TranscodeProgressResponse,
	UpdatePlaybackProgress,
} from "@reelvault/sdk/common";
import { pluginsService } from "@/application/plugins.service";
import { liveSessionsRepository } from "@/database/repositories/live-sessions.repository";
import { realtimeService } from "@/modules/realtime";
import { toMap } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { workerService } from "@/workers/worker.service";
import { diagnosticsService } from "./diagnostics/diagnostics.service";
import { heartbeatService } from "./heartbeat/heartbeat.service";
import { playlistService } from "./playlist/playlist.service";
import { playbackProgressService } from "./progress/playback-progress.service";
import { streamingService as streamingRuntimeService } from "./runtime/streaming.manager";
import { seekService } from "./seeking/seek.service";
import { segmentService } from "./segments/segment.service";
import { sessionLifecycleService } from "./sessions/session-lifecycle.service";
import type { SmartPlay } from "./streaming.types";

class PlaybackStreamingService extends BaseService {
	constructor() {
		super("PlaybackStreamingService");
		streamingRuntimeService.configureLifecycleCallbacks({
			cancelOperation: async (operationId) => await workerService.cancelOperation(operationId),
			onSessionStarted: ({ sessionId, mediaFileId, profileId }) => {
				pluginsService.publish("playback.session.started", { sessionId, mediaFileId });
				// Per-session/per-profile, not a global broadcast — other users must
				// not receive session ids or media ids.
				realtimeService.sendToProfile(profileId, "playback:session:started", { sessionId, mediaFileId });
			},
			onSessionEnded: ({ sessionId, mediaFileId, profileId, reason }) => {
				pluginsService.publish("playback.session.ended", { sessionId, mediaFileId, reason });
				pluginsService.publish("playback.lifecycle.stopped", {
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

	// ─── Session Lifecycle ────────────────────────────────────────────────

	createPlaybackSession(
		body: CreatePlaybackSession,
		profileId: string | undefined,
		idempotencyKey: string,
		userId?: string,
	): Promise<PlaybackSession> {
		return sessionLifecycleService.createPlaybackSession(body, profileId, idempotencyKey, userId);
	}

	getActiveSessions(): number {
		return sessionLifecycleService.getActiveSessions();
	}

	getSessionAccess(sessionId: string): { mediaFileId: string; profileId: string } | undefined {
		return sessionLifecycleService.getSessionAccess(sessionId);
	}

	/** Active playback sessions owned by one profile, with media titles (remote-control page). */
	async listMine(profileId: string | undefined) {
		if (!profileId) return { sessions: [] };

		const sessions = streamingRuntimeService.listSessionsForProfile(profileId);
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

	releasePlaybackSession(sessionId: string): void {
		sessionLifecycleService.releasePlaybackSession(sessionId);
	}

	getTerminatedSession(sessionId: string) {
		return sessionLifecycleService.getTerminatedSession(sessionId);
	}

	// ─── Playlist ─────────────────────────────────────────────────────────

	getPlaylist(sessionId: string, signal?: AbortSignal): Promise<Blob> {
		return playlistService.get(sessionId, signal);
	}

	// ─── Segments ─────────────────────────────────────────────────────────

	getSegment(sessionId: string, segment: string, signal?: AbortSignal): Promise<Blob> {
		return segmentService.get(sessionId, segment, signal);
	}

	// ─── Seek ─────────────────────────────────────────────────────────────

	seek(sessionId: string, requestedPosition: number | null | undefined): Promise<StreamSeekResponse> {
		return seekService.seek(sessionId, requestedPosition);
	}

	// ─── Diagnostics ──────────────────────────────────────────────────────

	getDiagnostics(sessionId: string): Promise<PlaybackDiagnostics> {
		return diagnosticsService.getDiagnostics(sessionId);
	}

	getTranscodeProgress(sessionId: string): Promise<TranscodeProgressResponse> {
		return diagnosticsService.getTranscodeProgress(sessionId);
	}

	// ─── Heartbeat ────────────────────────────────────────────────────────

	heartbeat(
		sessionId: string,
		progress?: {
			position?: number | null;
			audioStreamIndex?: number | null;
			subtitleId?: string | null;
			duration?: number | null;
			isPaused?: boolean | null;
		},
	): Promise<StreamHeartbeatResponse> {
		return heartbeatService.execute(sessionId, progress);
	}

	// ─── Progress ─────────────────────────────────────────────────────────

	getSmartPlay(metadataId: string, profileId?: string): Promise<SmartPlay> {
		return playbackProgressService.getSmartPlay(metadataId, profileId);
	}

	updatePlaybackProgress(fileId: string, body: UpdatePlaybackProgress, profileId?: string): Promise<{ success: true }> {
		return playbackProgressService.updatePlaybackProgress(fileId, body, profileId);
	}

	resetPlaybackProgress(fileId: string, profileId?: string): Promise<{ success: true }> {
		return playbackProgressService.resetPlaybackProgress(fileId, profileId);
	}

	getPlaybackProgress(metadataId: string, profileId?: string): Promise<MetadataPlaybackProgress> {
		return playbackProgressService.getPlaybackProgress(metadataId, profileId);
	}

	getContinueWatching(profileId?: string, limit = 12): Promise<{ items: ContinueWatchingItem[] }> {
		return playbackProgressService.getContinueWatching(profileId, limit);
	}
}

export const playbackStreamingService = new PlaybackStreamingService();
