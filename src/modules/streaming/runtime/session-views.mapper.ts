import type { PlaybackMode, SessionLifecycleState, StreamingSession } from "@reelvault/sdk/common";
import type { DetectedHwaccel } from "@/integrations/ffmpeg/capabilities/hwaccel.utils";
import type { ToneMappingMethod } from "@/integrations/ffmpeg/capabilities/tone-mapping.resolver";
import { getEffectiveHwaccel, getToneMappingMethod } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { resolveStreamEncoders } from "@/modules/streaming/diagnostics/encoder-map.resolver";
import { serializeDate } from "@/utils/time.utils";

/**
 * FFmpeg environment a session was created with. Diagnostics must describe the
 * process that is actually running: an admin flipping `ffmpeg.hwaccel` or the
 * tone-mapping method mid-session must not rewrite what a stream reports.
 */
export interface StreamEnvironment {
	hwaccel: DetectedHwaccel;
	toneMapMethod: ToneMappingMethod;
}

export interface ProfileSessionView {
	sessionId: string;
	mediaFileId: string;
	mode: PlaybackMode;
	state: SessionLifecycleState;
	startedAt: number;
	lastActivity: number;
	lastPositionSeconds: number | null;
	lastPaused: boolean | null;
}

/** The diagnostics payload for one session, described against the environment it was created in. */
export function buildSessionDiagnostics(session: StreamingSession, environment: StreamEnvironment | undefined) {
	const effectiveHw = environment?.hwaccel ?? getEffectiveHwaccel();
	const { videoEncoder, audioEncoder } = resolveStreamEncoders(session.decision, effectiveHw);

	return {
		mode: session.mode,
		operationId: session.operationId,
		videoTranscode: session.decision.videoTranscode,
		audioTranscode: session.decision.audioTranscode,
		videoEncoder,
		audioEncoder,
		targetVideoBitrateKbps: session.decision.videoBitrateKbps ?? null,
		hwaccel: effectiveHw.type,
		tonemapped: session.decision.tonemap ?? false,
		toneMapMethod: environment?.toneMapMethod ?? getToneMappingMethod(),
		reasons: session.decision.reasons ?? { video: { code: "unknown" }, audio: { code: "unknown" } },
		audioStreamIndex: session.decision.audioStreamIndex,
		startTime: session.startTime,
		startedAt: serializeDate(session.createdAt),
		lastActivityAt: serializeDate(session.lastActivity),
		processId: session.process?.pid ?? null,
		processExitCode: session.process?.exitCode ?? null,
		encodePositionSeconds: session.transcodePositionMs === null ? null : Number((session.transcodePositionMs / 1000).toFixed(2)),
		encodePercent: session.transcodePercent,
		encodeSpeed: session.transcodeSpeed,
	};
}

export function toProfileSessionView(session: StreamingSession): ProfileSessionView {
	return {
		sessionId: session.id,
		mediaFileId: session.mediaFileId,
		mode: session.mode,
		state: session.state,
		startedAt: session.createdAt,
		lastActivity: session.lastActivity,
		lastPositionSeconds: session.lastPositionSeconds ?? null,
		lastPaused: session.lastPaused ?? null,
	};
}
