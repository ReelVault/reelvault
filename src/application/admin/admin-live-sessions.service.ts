import type { AdminActiveDeviceItem, AdminLiveActivityResponse, AdminLiveStreamItem } from "@reelvault/sdk/common";
import { liveSessionsRepository } from "@/database/repositories/live-sessions.repository";
import { getEffectiveHwaccel } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { realtimeService } from "@/modules/realtime";
import { streamingService } from "@/modules/streaming/runtime/streaming.manager";
import { computeProgressPercent } from "@/modules/streaming/utils/playback-position.utils";
import { serverConfig } from "@/server.config";
import { MINUTE } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { groupBy, toMap, unique } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { NotFoundError } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";
import { PromiseUtils } from "@/utils/promise.utils";
import { serializeDate } from "@/utils/time.utils";

const LIVE_ACTIVITY_CACHE_TTL_MS = 2_000;

class AdminLiveSessionsService extends BaseService {
	private readonly activityCache = new MemoryCache<AdminLiveActivityResponse>({
		name: "admin-live-activity",
		ttlMs: LIVE_ACTIVITY_CACHE_TTL_MS,
		maxSize: 1,
	});

	constructor() {
		super("AdminLiveSessionsService");
	}

	async getLiveActivity(): Promise<AdminLiveActivityResponse> {
		return await this.activityCache.getOrSet("activity", () =>
			this.safeExecute("getLiveActivity", async () => {
				const activeStreamSessions = streamingService.getAllActiveSessions();
				const effectiveHw = getEffectiveHwaccel();

				const activeStreams = await this.resolveActiveStreams(activeStreamSessions, effectiveHw);
				const activeDevices = await this.resolveActiveDevices();
				const { canSafelyUpdate, warning } = this.computeMaintenanceStatus(activeStreams, activeDevices);

				return {
					activeStreams,
					activeDevices,
					canSafelyUpdate,
					warning,
				};
			}),
		);
	}

	private async resolveActiveStreams(
		activeStreamSessions: ReturnType<typeof streamingService.getAllActiveSessions>,
		effectiveHw: ReturnType<typeof getEffectiveHwaccel>,
	): Promise<AdminLiveStreamItem[]> {
		if (activeStreamSessions.length === 0) return [];

		const streamData = await this.fetchActiveStreamData(activeStreamSessions);
		const maps = buildSessionMaps({ activeStreamSessions, ...streamData });

		return this.hydrateActiveStreams(activeStreamSessions, maps, effectiveHw);
	}

	private async fetchActiveStreamData(activeStreamSessions: ReturnType<typeof streamingService.getAllActiveSessions>) {
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
			PromiseUtils.mapConcurrent(activeStreamSessions, systemResourcesService.getIoConcurrency(), (s) =>
				streamingService.getBuffer(s.id).catch(() => null),
			),
		]);

		return { mediaFilesData, profilesData, progressData, videoStreamsData, audioStreamsData, latestUserSessions, bufferAnalyses };
	}

	private hydrateActiveStreams(
		activeStreamSessions: ReturnType<typeof streamingService.getAllActiveSessions>,
		maps: ReturnType<typeof buildSessionMaps>,
		effectiveHw: ReturnType<typeof getEffectiveHwaccel>,
	): AdminLiveStreamItem[] {
		const activeStreams: AdminLiveStreamItem[] = [];
		for (const session of activeStreamSessions) {
			const media = maps.mediaMap.get(session.mediaFileId);
			const profile = maps.profileMap.get(session.profileId);
			if (!(media && profile)) continue;

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
			const isSessionActive = streamingService.isSessionActive(session.id);
			const bufferState = resolveBufferState(bufferAnalysis?.complete, isSessionActive);

			const userSession = maps.userSessionMap.get(profile.userId);
			const parsedUa = parseUserAgent(userSession?.userAgent);

			activeStreams.push({
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
				releaseYear: media.releaseDate ? new Date(media.releaseDate).getFullYear() : null,
				seasonNumber: media.seasonNumber ?? null,
				episodeNumber: media.episodeNumber ?? null,
				episodeTitle: media.episodeTitle ?? null,
				posterUrl: media.posterImageId ? `${serverConfig.security.imageRoutePrefix}${media.posterImageId}` : null,
				posterUpdatedAt: media.posterImageUpdatedAt ?? null,
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
				bitrateKbps: media.bitRate ? Math.round(media.bitRate / 1000) : null,
				targetVideoBitrateKbps: session.decision.videoBitrateKbps ?? null,
				...audioStreamProps(targetAudioStream, session.decision),
				processId: session.process?.pid ?? null,
				bufferedSeconds: bufferAnalysis ? Number(bufferAnalysis.bufferedSeconds.toFixed(2)) : null,
				bufferedUntil: bufferAnalysis ? Number(bufferAnalysis.bufferedUntil.toFixed(2)) : null,
				bufferState,
				encodePositionSeconds: session.transcodePositionMs !== null ? Number((session.transcodePositionMs / 1000).toFixed(2)) : null,
				encodePercent: session.transcodePercent,
				encodeSpeed: session.transcodeSpeed,
				clientName: parsedUa.clientName,
				browser: parsedUa.browser,
				os: parsedUa.os,
				ipAddress: userSession?.ipAddress ?? null,
				startedAt: serializeDate(session.createdAt),
				lastActivityAt: serializeDate(session.lastActivity),
			});
		}

		return activeStreams;
	}
	private async resolveActiveDevices(): Promise<AdminActiveDeviceItem[]> {
		const ACTIVE_DEVICE_WINDOW = 15 * MINUTE;
		const activeWindow = new Date(Date.now() - ACTIVE_DEVICE_WINDOW);
		const now = new Date();

		const activeUserSessions = await liveSessionsRepository.findActiveUserSessions({ since: activeWindow, now, limit: 20 });

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

	async terminateSession(sessionId: string, reason?: string): Promise<{ success: true }> {
		return await this.safeExecute("terminateSession", async () => {
			const effectiveReason = reason ?? "admin.terminated";
			const access = streamingService.getSessionAccess(sessionId);
			const terminated = streamingService.getTerminatedSession(sessionId);

			// Idempotent terminate: a session that already finished its teardown is a
			// success, not an error — only never-seen IDs are a real 404.
			if (!access) {
				if (terminated) return { success: true };

				throw new NotFoundError(`Active session not found: ${sessionId}`, {
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
			const outcome = await streamingService.releaseSession(sessionId, effectiveReason);
			if (outcome === "unknown") {
				throw new NotFoundError(`Active session not found: ${sessionId}`, {
					code: "stream.session_not_found",
					params: { sessionId },
				});
			}

			return { success: true };
		});
	}
}

/** Returns stable codes; the frontend maps them to localized labels. */
function parseUserAgent(ua?: string | null): { clientName: string; browser: string; os: string } {
	if (!ua) return { clientName: "unknown", browser: "unknown", os: "unknown" };

	let browser = "web";
	let os = "unknown";
	let clientName = "web";

	if (ua.includes("Firefox/")) browser = "firefox";
	else if (ua.includes("Edg/")) browser = "edge";
	else if (ua.includes("Chrome/")) browser = "chrome";
	else if (ua.includes("Safari/")) browser = "safari";

	if (ua.includes("Android")) {
		os = "android";
		clientName = ua.includes("TV") ? "android_tv" : "android_mobile";
	} else if (ua.includes("iPhone") || ua.includes("iPad")) {
		os = "ios";
		clientName = "apple_ios";
	} else if (ua.includes("Windows")) {
		os = "windows";
		clientName = "windows_pc";
	} else if (ua.includes("Macintosh") || ua.includes("Mac OS")) {
		os = "macos";
		clientName = "apple_mac";
	} else if (ua.includes("Linux")) {
		os = "linux";
		clientName = "linux_pc";
	}

	return { clientName, browser, os };
}

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
	if (audioStreamIndex != null) return audioStreams.find((a) => a.index === audioStreamIndex) ?? fallback;

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

function buildSessionMaps(params: {
	activeStreamSessions: ReturnType<typeof streamingService.getAllActiveSessions>;
	mediaFilesData: Awaited<ReturnType<typeof liveSessionsRepository.findMediaSummaries>>;
	profilesData: Awaited<ReturnType<typeof liveSessionsRepository.findProfilesWithUsers>>;
	progressData: Awaited<ReturnType<typeof liveSessionsRepository.findProgress>>;
	videoStreamsData: Awaited<ReturnType<typeof liveSessionsRepository.findVideoStreams>>;
	audioStreamsData: Awaited<ReturnType<typeof liveSessionsRepository.findAudioStreams>>;
	latestUserSessions: Awaited<ReturnType<typeof liveSessionsRepository.findLatestUserSessions>>;
	bufferAnalyses: Array<Awaited<ReturnType<typeof streamingService.getBuffer>> | null>;
}) {
	const {
		activeStreamSessions,
		mediaFilesData,
		profilesData,
		progressData,
		videoStreamsData,
		audioStreamsData,
		latestUserSessions,
		bufferAnalyses,
	} = params;

	const mediaMap = toMap(mediaFilesData, (m) => m.mediaFileId);
	const profileMap = toMap(profilesData, (p) => p.profileId);
	const progressMap = toMap(progressData, (p) => `${p.profileId}-${p.mediaFileId}`);
	const videoStreamsByMedia = groupBy(videoStreamsData, (v) => v.mediaFileId);
	const audioStreamsByMedia = groupBy(audioStreamsData, (a) => a.mediaFileId);
	const userSessionMap = toMap(latestUserSessions, (s) => s.userId);

	const bufferMap = new Map<string, (typeof bufferAnalyses)[number] | null>();
	for (let i = 0; i < activeStreamSessions.length; i++) {
		const session = activeStreamSessions[i];
		const analysis = bufferAnalyses[i];
		if (session) bufferMap.set(session.id, analysis ?? null);
	}

	return { mediaMap, profileMap, progressMap, videoStreamsByMedia, audioStreamsByMedia, userSessionMap, bufferMap };
}

export const adminLiveSessionsService = new AdminLiveSessionsService();
