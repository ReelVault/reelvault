import type { AdminLiveStreamItem, StreamingSession } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import type { DetectedHwaccel } from "@/integrations/ffmpeg/capabilities/hwaccel.utils";
import { computeProgressPercent } from "@/modules/streaming/utils/playback-position.utils";
import { serializeDate } from "@/utils/time.utils";
import { isNullish } from "@/utils/type.utils";
import type { SessionMaps } from "./session-maps.utils";
import { parseUserAgent } from "./user-agent.parser";

function videoStreamProps(
	stream:
		| {
				codecName: string | null;
				profile: string | null;
				width: number | null;
				height: number | null;
				frameRate: string | null;
				pixelFormat: string | null;
		  }
		| undefined,
	decision: { videoCodec?: string | null | undefined; videoBitrateKbps?: number | null | undefined },
) {
	return {
		videoCodec: stream?.codecName ?? decision.videoCodec ?? null,
		videoProfile: stream?.profile ?? null,
		width: stream?.width ?? null,
		height: stream?.height ?? null,
		frameRate: stream?.frameRate ?? null,
		pixelFormat: stream?.pixelFormat ?? null,
	};
}

function audioStreamProps(
	stream:
		| {
				index: number;
				codecName: string | null;
				channels: number | null;
				channelLayout: string | null;
				language: string | null;
				title: string | null;
		  }
		| undefined,
	decision: { audioStreamIndex?: number | null | undefined },
) {
	return {
		audioStreamIndex: stream?.index ?? decision.audioStreamIndex ?? null,
		audioCodec: stream?.codecName ?? null,
		audioChannels: stream?.channels ?? null,
		audioChannelLayout: stream?.channelLayout ?? null,
		audioLanguage: stream?.language ?? null,
		audioTitle: stream?.title ?? null,
	};
}

function resolveTargetAudioStream<T extends { index: number; isDefault: boolean }>(
	audioStreams: T[],
	audioStreamIndex: number | null | undefined,
): T | undefined {
	const fallback = audioStreams[0];
	if (!isNullish(audioStreamIndex)) return audioStreams.find((a) => a.index === audioStreamIndex) ?? fallback;

	return audioStreams.find((a) => a.isDefault) ?? fallback;
}

function resolveVideoEncoder(videoTranscode: boolean, hwType: string, h264Encoder: string): string {
	if (!videoTranscode) return "copy";

	if (hwType !== "none") return h264Encoder;

	return "libx264";
}

function resolveBufferState(bufferComplete: boolean | undefined, isSessionActive: boolean): "completed" | "pending" | "transcoding" {
	if (bufferComplete) return "completed";

	if (isSessionActive) return "transcoding";

	return "pending";
}

/** One live stream row, or null when its media file or profile is no longer known. */
export function buildActiveStreamItem(
	session: StreamingSession,
	maps: SessionMaps,
	effectiveHw: DetectedHwaccel,
	isSessionActive: boolean,
): AdminLiveStreamItem | null {
	const media = maps.mediaMap.get(session.mediaFileId);
	const profile = maps.profileMap.get(session.profileId);
	if (!(media && profile)) return null;

	const prog = maps.progressMap.get(`${session.profileId}-${session.mediaFileId}`);
	const currentTime = prog?.position ?? session.startTime;
	const totalDurationSeconds = prog?.duration ?? media.duration ?? 0;
	const progressPercent = computeProgressPercent(currentTime, totalDurationSeconds);

	const videoStreams = maps.videoStreamsByMedia.get(session.mediaFileId) ?? [];
	const audioStreams = maps.audioStreamsByMedia.get(session.mediaFileId) ?? [];
	const targetVideoStream = videoStreams.find((v) => v.isDefault) ?? videoStreams[0];
	const targetAudioStream = resolveTargetAudioStream(audioStreams, session.decision.audioStreamIndex);

	const videoEncoder = resolveVideoEncoder(session.decision.videoTranscode, effectiveHw.type, effectiveHw.h264Encoder);
	const audioEncoder = session.decision.audioTranscode ? "aac" : "copy";

	const bufferAnalysis = maps.bufferMap.get(session.id) ?? null;
	const bufferState = resolveBufferState(bufferAnalysis?.complete, isSessionActive);

	const userSession = maps.userSessionMap.get(profile.userId);
	const parsedUa = parseUserAgent(userSession?.userAgent);

	return {
		sessionId: session.id,
		profileId: profile.profileId,
		profileName: profile.profileName,
		profileAvatar: profile.profileAvatar,
		userId: profile.userId,
		userName: profile.userName,
		userEmail: profile.userEmail,
		mediaFileId: session.mediaFileId,
		metadataId: media.metadataId,
		title: media.title,
		type: media.type,
		...mediaItemFields(media),
		backdropUrl: null,
		currentTime: Math.round(currentTime),
		duration: Math.round(totalDurationSeconds),
		progressPercent,
		mode: session.mode,
		videoTranscode: session.decision.videoTranscode,
		audioTranscode: session.decision.audioTranscode,
		videoEncoder,
		audioEncoder,
		hwaccel: effectiveHw.type,
		transcodeReasons: session.decision.reasons ?? null,
		...videoStreamProps(targetVideoStream, session.decision),
		targetVideoBitrateKbps: session.decision.videoBitrateKbps ?? null,
		...audioStreamProps(targetAudioStream, session.decision),
		processId: session.process?.pid ?? null,
		...bufferFields(bufferAnalysis),
		bufferState,
		encodePositionSeconds: session.transcodePositionMs === null ? null : Number((session.transcodePositionMs / 1000).toFixed(2)),
		encodePercent: session.transcodePercent,
		encodeSpeed: session.transcodeSpeed,
		clientName: parsedUa.clientName,
		browser: parsedUa.browser,
		os: parsedUa.os,
		ipAddress: userSession?.ipAddress ?? null,
		startedAt: serializeDate(session.createdAt),
		lastActivityAt: serializeDate(session.lastActivity),
	};
}

/** The media fields of a live-stream row. */
function mediaItemFields(media: NonNullable<ReturnType<SessionMaps["mediaMap"]["get"]>>) {
	return {
		releaseYear: media.releaseDate ? new Date(media.releaseDate).getFullYear() : null,
		seasonNumber: media.seasonNumber ?? null,
		episodeNumber: media.episodeNumber ?? null,
		episodeTitle: media.episodeTitle ?? null,
		posterUrl: media.posterImageId ? `${serverConfig.security.imageRoutePrefix}${media.posterImageId}` : null,
		posterUpdatedAt: media.posterImageUpdatedAt ?? null,
		bitrateKbps: media.bitRate ? Math.round(media.bitRate / 1000) : null,
	};
}

/** The buffer fields of a live-stream row. */
function bufferFields(bufferAnalysis: { bufferedSeconds: number; bufferedUntil: number } | null) {
	return {
		bufferedSeconds: bufferAnalysis ? Number(bufferAnalysis.bufferedSeconds.toFixed(2)) : null,
		bufferedUntil: bufferAnalysis ? Number(bufferAnalysis.bufferedUntil.toFixed(2)) : null,
	};
}
