import type { SessionLifecycleState, StreamHeartbeatResponse } from "@reelvault/sdk/common";
import { realtimeService } from "@/modules/realtime";
import { BaseService } from "@/utils/base-service";
import { isFiniteNumber } from "@/utils/type.utils";
import { defaultRequireSession } from "../contracts";
import { playbackProgressService } from "../progress/playback-progress.service";
import { streamingService as streamingRuntimeService } from "../runtime/streaming.manager";
import type { RequireSession } from "../streaming.types";

interface ServiceDependencies {
	requireSession: RequireSession;
	keepAlive: (sessionId: string) => void;
	getSessionState: (sessionId: string) => { state: SessionLifecycleState; generation: number } | undefined;
	updatePlaybackProgress: typeof playbackProgressService.updatePlaybackProgress;
	sendSessionEvent?: (sessionId: string, event: string, payload: unknown) => void;
}

const defaultDependencies: ServiceDependencies = {
	requireSession: defaultRequireSession,
	keepAlive: (sessionId) => streamingRuntimeService.keepAlive(sessionId),
	getSessionState: (sessionId) => streamingRuntimeService.getSessionState(sessionId),
	updatePlaybackProgress: (fileId, body, profileId) => playbackProgressService.updatePlaybackProgress(fileId, body, profileId),
	sendSessionEvent: (sessionId, event, payload) => realtimeService.sendToSession(sessionId, event, payload),
};

export class HeartbeatService extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("HeartbeatService");
		this.dependencies = dependencies;
	}

	async execute(
		sessionId: string,
		progress?: {
			position?: number | null;
			audioStreamIndex?: number | null;
			subtitleId?: string | null;
			duration?: number | null;
			isPaused?: boolean | null;
		},
	): Promise<StreamHeartbeatResponse> {
		const { requireSession, keepAlive, getSessionState, updatePlaybackProgress, sendSessionEvent } = this.dependencies;
		const access = requireSession(sessionId);
		keepAlive(sessionId);
		if (isFiniteNumber(progress?.position)) {
			await updatePlaybackProgress(access.mediaFileId, progress, access.profileId).catch((error: unknown) =>
				this.logger.error("Heartbeat progress write failed", error, { sessionId }),
			);
		}

		if (sendSessionEvent && (isFiniteNumber(progress?.position) || progress?.isPaused != null)) {
			sendSessionEvent(sessionId, "playback:session:progress", {
				sessionId,
				position: progress.position ?? undefined,
				duration: progress.duration ?? undefined,
				isPaused: progress.isPaused ?? undefined,
			});
		}

		// Real session state lets the client tell "process finished (healthy)"
		// from "session gone (reconnect)" instead of blindly reconnecting.
		const state = getSessionState(sessionId);

		return {
			status: "ok",
			sessionId,
			timestamp: new Date().toISOString(),
			state: state?.state ?? "active",
			generation: state?.generation ?? 0,
		};
	}
}

export const heartbeatService = new HeartbeatService();
