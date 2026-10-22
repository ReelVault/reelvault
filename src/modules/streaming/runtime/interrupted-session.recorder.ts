import { isCompleted } from "@/modules/streaming/utils/playback-position.utils";
import { interruptedPlaybackSessionRepository } from "@/repositories/interrupted-playback-session.repository";
import { createLogger } from "@/utils/logger.utils";

const logger = createLogger("InterruptedSessionRecorder");

export interface EndedPlaybackSession {
	profileId: string;
	mediaFileId: string;
	reason: string;
	startedAt: number;
	playedSeconds: number;
	furthestPositionSeconds: number;
	durationSeconds: number | null;
}

/**
 * Keeps a session that ended before its title was finished, with the media time it played, so the admin analytics can
 * count it. A session that reached the completion line is skipped: watched history already holds its row.
 */
export async function recordInterruptedSession(session: EndedPlaybackSession, endedAt = new Date()): Promise<void> {
	const playedSeconds = Math.round(session.playedSeconds);
	if (playedSeconds <= 0) return;
	if (isCompleted(session.furthestPositionSeconds, session.durationSeconds ?? 0)) return;

	try {
		await interruptedPlaybackSessionRepository.insert({
			profileId: session.profileId,
			mediaFileId: session.mediaFileId,
			startedAt: new Date(session.startedAt),
			endedAt,
			playedSeconds,
			furthestPositionSeconds: Math.round(session.furthestPositionSeconds),
			durationSeconds: session.durationSeconds,
			reason: session.reason,
		});
	} catch (error) {
		logger.error("Failed to record an interrupted playback session", error, { mediaFileId: session.mediaFileId });
	}
}
