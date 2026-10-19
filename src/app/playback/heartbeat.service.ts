import type { SessionLifecycleState, StreamHeartbeatResponse } from "@reelvault/sdk/common";
import { playbackProgressService } from "@/app/playback/playback-progress.service";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { defaultRequireSession } from "@/modules/streaming/contracts.utils";
import { streamingManager as streamingRuntimeService } from "@/modules/streaming/runtime/streaming.manager";
import type { RequireSession } from "@/modules/streaming/streaming.types";
import { createLogger } from "@/utils/logger.utils";
import { isFiniteNumber, isNullish } from "@/utils/type.utils";

interface ServiceDependencies {
	requireSession: RequireSession;
	keepAlive: (sessionId: string) => void;
	getSessionState: (sessionId: string) => { state: SessionLifecycleState; generation: number } | undefined;
	updatePlaybackProgress: typeof playbackProgressService.updatePlaybackProgress;
	sendSessionEvent?: (sessionId: string, event: string, payload: unknown) => void;
	recordPosition?: (sessionId: string, positionSeconds: number, paused: boolean | null) => void;
}

const defaultDependencies: ServiceDependencies = {
	requireSession: defaultRequireSession,
	keepAlive: (sessionId) => streamingRuntimeService.keepAlive(sessionId),
	getSessionState: (sessionId) => streamingRuntimeService.getSessionState(sessionId),
	updatePlaybackProgress: (fileId, body, profileId) => playbackProgressService.updatePlaybackProgress(fileId, body, profileId),
	sendSessionEvent: (sessionId, event, payload) => realtimeService.sendToSession(sessionId, event, payload),
	recordPosition: (sessionId, positionSeconds, paused) =>
		streamingRuntimeService.recordHeartbeatPosition(sessionId, positionSeconds, paused),
};

export class HeartbeatService {
	readonly serviceName = "HeartbeatService";
	readonly logger = createLogger("HeartbeatService");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
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
		const { requireSession, keepAlive, getSessionState, updatePlaybackProgress, sendSessionEvent, recordPosition } = this.dependencies;
		const access = requireSession(sessionId);
		keepAlive(sessionId);
		const position = progress?.position;
		if (recordPosition && isFiniteNumber(position)) recordPosition(sessionId, position, progress?.isPaused ?? null);
		if (isFiniteNumber(progress?.position)) {
			await updatePlaybackProgress(access.mediaFileId, progress, access.profileId).catch((error: unknown) =>
				this.logger.error("Heartbeat progress write failed", error, { sessionId }),
			);
		}

		if (sendSessionEvent && (isFiniteNumber(progress?.position) || !isNullish(progress?.isPaused))) {
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
