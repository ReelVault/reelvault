import type {
	CreatePlaybackSession,
	MyPlaybackSessionsResponse,
	PlaybackDiagnostics,
	PlaybackSession,
	PlaybackViewResponse,
	StreamHeartbeatResponse,
	StreamSeekResponse,
	TranscodeProgressResponse,
} from "@sdk/common";

import type { PlaybackCommand, PlaybackCommandType } from "@sdk/common/realtime";

import { BaseResource } from "../core/base-client";

export class PlaybackSessionsClient extends BaseResource {
	getView(mediaFileId: string): Promise<PlaybackViewResponse> {
		if (!mediaFileId) return Promise.reject(new Error("mediaFileId is required"));

		return this._get<PlaybackViewResponse>(`/playback-sessions/view/${mediaFileId}`);
	}

	listMine(): Promise<MyPlaybackSessionsResponse> {
		return this._get<MyPlaybackSessionsResponse>("/playback-sessions/mine");
	}

	create(body: CreatePlaybackSession, options?: { idempotencyKey?: string }): Promise<PlaybackSession> {
		// Validation and normalization (codec cleanup, ranges, defaults) live on
		// the server contract — raw client state goes out as-is.
		return this._post("/playback-sessions", {
			body,
			headers: { "Idempotency-Key": options?.idempotencyKey ?? crypto.randomUUID() },
		});
	}

	getPlaylist(sessionId: string): Promise<Blob> {
		if (!sessionId) return Promise.reject(new Error("sessionId is required"));

		return this._get<Blob>(`/playback-sessions/${sessionId}/playlist`);
	}

	getPlaylistUrl(sessionId: string): string {
		return new URL(`/v1/playback-sessions/${sessionId}/playlist`, this.getBaseUrl()).toString();
	}

	getSegment(sessionId: string, segment: string): Promise<Blob> {
		if (!sessionId) return Promise.reject(new Error("sessionId is required"));

		if (!segment) return Promise.reject(new Error("segment is required"));

		return this._get<Blob>(`/playback-sessions/${sessionId}/segments/${segment}`);
	}

	getSegmentUrl(sessionId: string, segment: string): string {
		return new URL(`/v1/playback-sessions/${sessionId}/segments/${segment}`, this.getBaseUrl()).toString();
	}

	sendCommand(
		sessionId: string,
		command: PlaybackCommand,
	): Promise<{ delivered: boolean; command: PlaybackCommandType; position?: number; relative?: number; volume?: number }> {
		if (!sessionId) return Promise.reject(new Error("sessionId is required"));

		return this._post(`/events/playback-sessions/${sessionId}/command`, {
			body: command,
		});
	}

	seek(sessionId: string, position: number): Promise<StreamSeekResponse> {
		if (!sessionId) return Promise.reject(new Error("sessionId is required"));

		// The server clamps the position to [0, duration].
		return this._post<StreamSeekResponse>(`/playback-sessions/${sessionId}/seek`, {
			body: { position },
		});
	}

	getTranscodeProgress(sessionId: string): Promise<TranscodeProgressResponse> {
		if (!sessionId) return Promise.reject(new Error("sessionId is required"));

		return this._get<TranscodeProgressResponse>(`/playback-sessions/${sessionId}/transcode-progress`);
	}

	getDiagnostics(sessionId: string): Promise<PlaybackDiagnostics> {
		if (!sessionId) return Promise.reject(new Error("sessionId is required"));

		return this._get<PlaybackDiagnostics>(`/playback-sessions/${sessionId}/diagnostics`);
	}

	keepAlive(
		sessionId: string,
		progress?: {
			position?: number | null;
			audioStreamIndex?: number | null;
			subtitleId?: string | null;
			duration?: number | null;
			isPaused?: boolean | null;
		},
	): Promise<StreamHeartbeatResponse> {
		if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
			return Promise.resolve({ status: "ok", sessionId: "", timestamp: new Date().toISOString(), state: "active", generation: 0 });
		}

		// Optional piggy-backed playback progress — one request instead of
		// heartbeat + progress-save on every interval.
		return this._post<StreamHeartbeatResponse>(`/playback-sessions/${sessionId}/heartbeat`, { body: progress ?? undefined });
	}

	release(sessionId: string): Promise<void> {
		if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
			return Promise.resolve();
		}

		return this._delete<void>(`/playback-sessions/${sessionId}`);
	}
}
