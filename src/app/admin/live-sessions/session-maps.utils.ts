import type { StreamingSession } from "@reelvault/sdk/common";
import type { liveSessionsRepository } from "@/app/repositories/live-sessions.repository";
import type { HlsBufferAnalysis } from "@/modules/streaming/streaming.types";
import { groupBy, toMap } from "@/utils/array.utils";

/** Rows the live-sessions view reads for the active streams, fetched in one batch. */
export interface ActiveStreamData {
	mediaFilesData: Awaited<ReturnType<typeof liveSessionsRepository.findMediaSummaries>>;
	profilesData: Awaited<ReturnType<typeof liveSessionsRepository.findProfilesWithUsers>>;
	progressData: Awaited<ReturnType<typeof liveSessionsRepository.findProgress>>;
	videoStreamsData: Awaited<ReturnType<typeof liveSessionsRepository.findVideoStreams>>;
	audioStreamsData: Awaited<ReturnType<typeof liveSessionsRepository.findAudioStreams>>;
	latestUserSessions: Awaited<ReturnType<typeof liveSessionsRepository.findLatestUserSessions>>;
	/** Parallel to the active sessions; null where the buffer could not be read. */
	bufferAnalyses: Array<HlsBufferAnalysis | null>;
}

export function buildSessionMaps(activeStreamSessions: StreamingSession[], data: ActiveStreamData) {
	const mediaMap = toMap(data.mediaFilesData, (m) => m.mediaFileId);
	const profileMap = toMap(data.profilesData, (p) => p.profileId);
	const progressMap = toMap(data.progressData, (p) => `${p.profileId}-${p.mediaFileId}`);
	const videoStreamsByMedia = groupBy(data.videoStreamsData, (v) => v.mediaFileId);
	const audioStreamsByMedia = groupBy(data.audioStreamsData, (a) => a.mediaFileId);
	const userSessionMap = toMap(data.latestUserSessions, (s) => s.userId);

	const bufferMap = new Map<string, HlsBufferAnalysis | null>();
	for (const [index, session] of activeStreamSessions.entries()) {
		bufferMap.set(session.id, data.bufferAnalyses[index] ?? null);
	}

	return { mediaMap, profileMap, progressMap, videoStreamsByMedia, audioStreamsByMedia, userSessionMap, bufferMap };
}

export type SessionMaps = ReturnType<typeof buildSessionMaps>;
