import type {
	AdminActiveDeviceItem,
	AdminEndedLiveSessionsResponse,
	AdminLiveActivityResponse,
	AdminLiveStreamItem,
	BulkTerminateSessions,
	BulkTerminateSessionsResult,
	StreamingSession,
} from "@reelvault/sdk/common";
import { MINUTE } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import type { DetectedHwaccel } from "@/integrations/ffmpeg/capabilities/hwaccel.utils";
import { getEffectiveHwaccel } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { ENDED_SESSION_HISTORY_LIMIT, type EndedLiveSession, endedSessionHistory } from "@/modules/streaming/runtime/ended-session.history";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { liveSessionsRepository } from "@/repositories/live-sessions.repository";
import { recordAuditSafe } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { toMap, unique } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { mapConcurrent } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { serializeDate } from "@/utils/time.utils";
import { buildSessionLogArchive, readSessionLogFiles, sessionLogArchiveName, sessionLogSegments } from "./live-session-log.utils";
import { type ActiveStreamData, buildSessionMaps } from "./live-sessions/session-maps.utils";
import { buildActiveStreamItem } from "./live-sessions/stream-item.mapper";
import { parseUserAgent } from "./live-sessions/user-agent.parser";

const LIVE_ACTIVITY_CACHE_TTL_MS = 2_000;
const ACTIVE_DEVICE_WINDOW_MS = 15 * MINUTE;
const ACTIVE_DEVICE_LIMIT = 20;

class AdminLiveSessionsService {
	readonly serviceName = "AdminLiveSessionsService";
	readonly logger = createLogger("AdminLiveSessionsService");

	private readonly activityCache = new MemoryCache<AdminLiveActivityResponse>({
		name: "admin-live-activity",
		ttlMs: LIVE_ACTIVITY_CACHE_TTL_MS,
		maxSize: 1,
	});

	async getLiveActivity(): Promise<AdminLiveActivityResponse> {
		return await this.activityCache.getOrSet("activity", () =>
			runSafely(this, "getLiveActivity", async () => {
				const activeStreamSessions = streamingManager.getAllActiveSessions();
				const effectiveHw = getEffectiveHwaccel();

				const activeStreams = await this.resolveActiveStreams(activeStreamSessions, effectiveHw);
				const activeDevices = await this.resolveActiveDevices();
				const { canSafelyUpdate, warning } = this.computeMaintenanceStatus(activeStreams, activeDevices);
				const { limit, active } = streamingManager.explainCapacityLimit();

				return {
					activeStreams,
					activeDevices,
					canSafelyUpdate,
					capacity: { limit, active },
					warning,
				};
			}),
		);
	}

	private async resolveActiveStreams(
		activeStreamSessions: StreamingSession[],
		effectiveHw: DetectedHwaccel,
	): Promise<AdminLiveStreamItem[]> {
		if (activeStreamSessions.length === 0) return [];

		const maps = buildSessionMaps(activeStreamSessions, await this.fetchActiveStreamData(activeStreamSessions));

		return activeStreamSessions
			.map((session) => buildActiveStreamItem(session, maps, effectiveHw, streamingManager.isSessionActive(session.id)))
			.filter((item): item is AdminLiveStreamItem => item !== null);
	}

	private async fetchActiveStreamData(activeStreamSessions: StreamingSession[]): Promise<ActiveStreamData> {
		const mediaFileIds = unique(activeStreamSessions, (s) => s.mediaFileId);
		const profileIds = unique(activeStreamSessions, (s) => s.profileId);

		const [mediaFilesData, profilesData, progressData, videoStreamsData, audioStreamsData] = await Promise.all([
			liveSessionsRepository.findMediaSummaries(mediaFileIds),
			liveSessionsRepository.findProfilesWithUsers(profileIds),
			liveSessionsRepository.findProgress(mediaFileIds, profileIds),
			liveSessionsRepository.findVideoStreams(mediaFileIds),
			liveSessionsRepository.findAudioStreams(mediaFileIds),
		]);

		const userIds = unique(profilesData, (p) => p.userId);
		const [latestUserSessions, bufferAnalyses] = await Promise.all([
			liveSessionsRepository.findLatestUserSessions(userIds),
			mapConcurrent(activeStreamSessions, systemResourcesService.getIoConcurrency(), (s) =>
				streamingManager.getBuffer(s.id).catch(() => null),
			),
		]);

		return { mediaFilesData, profilesData, progressData, videoStreamsData, audioStreamsData, latestUserSessions, bufferAnalyses };
	}

	/** The most recently ended live sessions, newest first, with their titles and profile names. */
	async getEndedSessions(limit: number): Promise<AdminEndedLiveSessionsResponse> {
		const ended = endedSessionHistory.list(limit);
		const [mediaRows, profileRows] = await Promise.all([
			liveSessionsRepository.findMediaSummaries(unique(ended.map((session) => session.mediaFileId))),
			liveSessionsRepository.findProfilesWithUsers(unique(ended.map((session) => session.profileId))),
		]);
		const mediaById = toMap(mediaRows, (row) => row.mediaFileId);
		const profileById = toMap(profileRows, (row) => row.profileId);

		return {
			data: ended.map((session) => ({
				sessionId: session.sessionId,
				mediaFileId: session.mediaFileId,
				title: mediaById.get(session.mediaFileId)?.title ?? null,
				profileId: session.profileId,
				profileName: profileById.get(session.profileId)?.profileName ?? null,
				reason: session.reason,
				startedAt: serializeDate(session.startedAt),
				endedAt: serializeDate(session.endedAt),
				durationSeconds: Math.max(0, Math.round((session.endedAt - session.startedAt) / 1000)),
			})),
		};
	}

	private async resolveActiveDevices(): Promise<AdminActiveDeviceItem[]> {
		const activeWindow = new Date(Date.now() - ACTIVE_DEVICE_WINDOW_MS);
		const now = new Date();

		const activeUserSessions = await liveSessionsRepository.findActiveUserSessions({
			since: activeWindow,
			now,
			limit: ACTIVE_DEVICE_LIMIT,
		});

		return activeUserSessions.map((s) => {
			const parsed = parseUserAgent(s.userAgent);

			return {
				sessionId: s.sessionId,
				userId: s.userId,
				userName: s.userName,
				userEmail: s.userEmail,
				ipAddress: s.ipAddress,
				userAgent: s.userAgent,
				clientName: parsed.clientName,
				browser: parsed.browser,
				os: parsed.os,
				lastSeenAt: s.updatedAt.toISOString(),
			};
		});
	}

	private computeMaintenanceStatus(
		activeStreams: AdminLiveStreamItem[],
		activeDevices: AdminActiveDeviceItem[],
	): { canSafelyUpdate: boolean; warning: { code: string; params?: Record<string, string | number | boolean | null> } | null } {
		const canSafelyUpdate = activeStreams.length === 0;
		let warning: { code: string; params?: Record<string, string | number | boolean | null> } | null = null;

		if (activeStreams.length > 0) {
			const names = unique(activeStreams, (s) => s.profileName);
			warning = { code: "admin.live_active_streams", params: { count: activeStreams.length, viewers: names.join(", ") } };
		} else if (activeDevices.length > 0) {
			warning = { code: "admin.live_no_streams", params: { count: activeDevices.length } };
		}

		return { canSafelyUpdate, warning };
	}

	/** Terminates each session on its own, so one failure does not stop the others; the outcome is audited with the reason. */
	async terminateSessions(body: BulkTerminateSessions, context?: AdminAuditContext): Promise<BulkTerminateSessionsResult> {
		const results: BulkTerminateSessionsResult["results"] = [];
		for (const sessionId of unique(body.sessionIds)) {
			try {
				await this.terminateSession(sessionId, body.reason);
				results.push({ sessionId, success: true });
			} catch (error) {
				results.push({ sessionId, success: false, errorCode: error instanceof DomainError ? error.code : "internal" });
			}
		}

		const terminated = results.filter((result) => result.success).length;
		const failed = results.length - terminated;
		recordAuditSafe(
			{
				action: "delete",
				resourceType: "stream_session",
				summary: body.reason ?? "admin.terminated",
				after: { sessionIds: body.sessionIds, reason: body.reason, terminated, failed },
				context,
			},
			this.logger,
		);

		return { terminated, failed, results };
	}

	/** The FFmpeg logs of a live or recently ended session as one zip, with a timeline of its runs. */
	async getSessionLog(sessionId: string): Promise<{ data: Uint8Array<ArrayBuffer>; filename: string }> {
		return await runSafely(this, "getSessionLog", async () => {
			const active = streamingManager.getAllActiveSessions().find((item) => item.id === sessionId);
			// An ended session is no longer active; its history entry names the operation its logs were written under.
			let ended: EndedLiveSession | undefined;
			if (!active) {
				ended = endedSessionHistory.list(ENDED_SESSION_HISTORY_LIMIT).find((item) => item.sessionId === sessionId);
			}
			if (!(active || ended)) {
				throw new DomainError("not_found", `Session not found: ${sessionId}`, {
					code: "stream.session_not_found",
					params: { sessionId },
				});
			}

			const operationId = active ? active.operationId : ended?.operationId;
			const { files, truncated } = await readSessionLogFiles(sessionLogSegments(sessionId, operationId));
			const zipped = await buildSessionLogArchive(sessionId, files, truncated);

			// A fresh buffer keeps the view narrow (`Uint8Array<ArrayBuffer>`), which the Response body type requires.
			const data = new Uint8Array(zipped.byteLength);
			data.set(zipped);

			return { data, filename: sessionLogArchiveName(sessionId, new Date()) };
		});
	}

	async terminateSession(sessionId: string, reason?: string): Promise<{ success: true }> {
		return await runSafely(this, "terminateSession", async () => {
			const effectiveReason = reason ?? "admin.terminated";
			const access = streamingManager.getSessionAccess(sessionId);
			const terminated = streamingManager.getTerminatedSession(sessionId);

			// Idempotent terminate: a session that already finished its teardown is a
			// success, not an error — only never-seen IDs are a real 404.
			if (!access) {
				if (terminated) return { success: true };

				throw new DomainError("not_found", `Active session not found: ${sessionId}`, {
					code: "stream.session_not_found",
					params: { sessionId },
				});
			}

			// 1. Notify client via Realtime WebSocket command before tearing down process
			realtimeService.sendPlaybackCommand(sessionId, { type: "stop" });
			realtimeService.sendToSession(sessionId, "playback:session:terminated", { sessionId, reason: effectiveReason });
			if (access.profileId) {
				realtimeService.sendToProfile(access.profileId, "playback:session:terminated", {
					sessionId,
					mediaFileId: access.mediaFileId,
					reason: effectiveReason,
				});
			}

			// 2. Tear down the stream process and mark as terminated
			const outcome = await streamingManager.releaseSession(sessionId, effectiveReason);
			if (outcome === "unknown") {
				throw new DomainError("not_found", `Active session not found: ${sessionId}`, {
					code: "stream.session_not_found",
					params: { sessionId },
				});
			}

			return { success: true };
		});
	}
}

export const adminLiveSessionsService = new AdminLiveSessionsService();
