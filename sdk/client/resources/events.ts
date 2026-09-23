import type { PlaybackCommand, PlaybackCommandResponse } from "@sdk/common/realtime";
import { BaseResource } from "../core/base-client";

const HTTP_PROTOCOL_REGEX = /^http/;

export class EventsClient extends BaseResource {
	/**
	 * Returns the absolute WebSocket URL for real-time events.
	 * Converts the configured baseUrl (http/https) to ws/wss and appends /v1/events/ws.
	 */
	getWebSocketUrl(query?: { profileId?: string }): string {
		const httpBase = this.getBaseUrl();
		const wsBase = httpBase.replace(HTTP_PROTOCOL_REGEX, "ws");
		const url = new URL(`${wsBase}/v1/events/ws`);
		if (query?.profileId) {
			url.searchParams.set("profileId", query.profileId);
		}

		return url.toString();
	}

	sendPlaybackCommand(sessionId: string, command: PlaybackCommand): Promise<PlaybackCommandResponse> {
		if (!sessionId) return Promise.reject(new Error("sessionId is required"));

		return this._post<PlaybackCommandResponse>(`/events/playback-sessions/${sessionId}/command`, {
			body: command,
		});
	}
}
