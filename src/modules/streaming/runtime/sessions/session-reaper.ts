import { workerJobRepository } from "@/database/repositories/worker.repository";
import { killFfmpegProcessGracefully } from "@/integrations/ffmpeg/ffmpeg.process";
import { ffmpegProcessTracker } from "@/integrations/ffmpeg/ffmpeg.process-tracker";
import { MINUTE } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { detach, PromiseUtils } from "@/utils/promise.utils";
import type { BufferAnalysisCache } from "../../buffer/buffer-analysis.cache";
import type { ProcessManager } from "../../ffmpeg/process-manager";
import type { SessionSeeker } from "../../seeking/session-seeker";
import type { StreamingLifecycleCallbacks } from "../../streaming.types";
import { transcodeProgressMonitor } from "../transcode-progress.monitor";
import type { SessionReservationTracker } from "./session-reservation.tracker";
import { RESERVATION_DEADLINE_MS, type SessionStore } from "./session-store";

export class SessionReaper {
	private readonly logger = createLogger(this.constructor.name);
	private cleanupTimer: Timer | null = null;
	private readonly store: SessionStore;
	private readonly reservations: SessionReservationTracker;
	private readonly processManager: Pick<ProcessManager, "removeTempDirectory">;
	private readonly bufferCache: BufferAnalysisCache;
	private readonly seeker: SessionSeeker;
	private readonly playlistWaiter: { invalidate(id: string): void; clear(): void };
	private readonly softwareFallbackSessions: Set<string>;

	constructor(
		store: SessionStore,
		reservations: SessionReservationTracker,
		processManager: Pick<ProcessManager, "removeTempDirectory">,
		bufferCache: BufferAnalysisCache,
		seeker: SessionSeeker,
		playlistWaiter: { invalidate(id: string): void; clear(): void },
		softwareFallbackSessions: Set<string>,
	) {
		this.store = store;
		this.reservations = reservations;
		this.processManager = processManager;
		this.bufferCache = bufferCache;
		this.seeker = seeker;
		this.playlistWaiter = playlistWaiter;
		this.softwareFallbackSessions = softwareFallbackSessions;
	}

	/**
	 * Reconciliation pass — the only server-side mechanism that releases idle
	 * sessions. A session dies exclusively on client silence (`lastActivity` is
	 * refreshed by every heartbeat/playlist/segment/seek): a finished FFmpeg
	 * process (encode-to-EOF) is a healthy state and must never expire a
	 * session a client is still watching.
	 */
	startInactivityTimer(
		config: { inactivityTimeout: () => number; cleanupInterval: number; isBusy?: (sessionId: string) => boolean },
		releaseSession: (sessionId: string, reason: string, shouldRelease?: (session: { lastActivity: number }) => boolean) => Promise<unknown>,
	): void {
		this.cleanupTimer = setInterval(() => {
			const now = Date.now();
			// Read the timeout per tick so a runtime settings change applies without
			// restarting the reaper (`cleanupInterval` still needs a restart — it is
			// the timer period itself).
			const timeout = config.inactivityTimeout();
			const inactiveIds: string[] = [];
			for (const session of this.store.values()) {
				// `creating` sessions are governed by the reservation deadline below;
				// `ending` sessions already have a release in flight.
				if (session.state !== "active") continue;

				// An in-flight seek/restart owns the session clock — it either
				// completes (refreshing activity) or fails without side effects.
				if (this.seeker.isSessionSeeking(session.id)) continue;

				// A long segment wait (up to ~33 s) counts as activity even though it
				// does not touch the clock while blocked.
				if (config.isBusy?.(session.id)) continue;

				if (now - session.lastActivity > timeout) inactiveIds.push(session.id);
			}

			if (inactiveIds.length > 0) {
				detach(
					(async () => {
						try {
							await PromiseUtils.mapConcurrent(inactiveIds, systemResourcesService.getHeavySubprocessConcurrency(), (id) =>
								// Re-check freshness atomically at claim time: a heartbeat that arrived
								// after this tick must cancel the release.
								releaseSession(id, "inactivity-timeout", (session) => Date.now() - session.lastActivity > timeout),
							);
						} catch {
							// releaseSession owns its error reporting; reaping must keep running.
						}
					})(),
				);
			}

			// A `creating` session past the deadline with no process is stuck. Do NOT
			// also require `reservations.isPending(id)`: a start failure releases the
			// reservation while leaving the entity, so the session became invisible
			// to both reaper branches and leaked until process restart.
			const deadlineMs = systemResourcesService.scaledTimeoutMs(RESERVATION_DEADLINE_MS);
			const candidates = this.store.findStaleReservations(now, deadlineMs).filter((id) => !this.store.isAttached(id));
			if (candidates.length > 0) {
				detach(
					(async () => {
						try {
							// A queued stream-init job (heavy-subprocess concurrency is 1-2) can
							// outlive the deadline under load — releasing then makes startSession 404.
							const staleIds: string[] = [];
							for (const id of candidates) {
								const operationId = this.store.get(id)?.operationId;
								if (operationId && (await workerJobRepository.hasActiveJobForOperation(operationId))) continue;

								staleIds.push(id);
							}

							if (staleIds.length === 0) return;

							this.logger.warn("Releasing session reservations stuck without a running process", { sessionIds: staleIds });
							await PromiseUtils.mapConcurrent(staleIds, systemResourcesService.getHeavySubprocessConcurrency(), (id) =>
								releaseSession(id, "reservation-deadline"),
							);
						} catch {
							// releaseSession owns its error reporting; reaping must keep running.
						}
					})(),
				);
			}

			this.store.cleanupTerminatedSessions(5 * MINUTE);
		}, config.cleanupInterval);
		this.cleanupTimer.unref();
	}

	async finalizeRelease(
		sessionId: string,
		reason: string,
		config: { tempRootDir: string },
		lifecycleCallbacks: StreamingLifecycleCallbacks,
	): Promise<void> {
		// Release was already claimed (state = `ending`), so no process start can
		// land after this read — the handle below is the last one this session had.
		const session = this.store.get(sessionId);
		const process = session?.process ?? null;
		if (process) ffmpegProcessTracker.markIntentionalKill(sessionId);
		try {
			await Promise.all([
				session?.operationId
					? lifecycleCallbacks.cancelOperation(session.operationId).catch(() => {
							/* intentionally empty */
						})
					: undefined,
				session?.operationId ? transcodeProgressMonitor.onSessionReleased(sessionId, session.operationId) : undefined,
				process
					? killFfmpegProcessGracefully(process).catch(() => {
							/* intentionally empty */
						})
					: undefined,
			]);
			if (process) ffmpegProcessTracker.forgetStderrTail(process);

			await this.processManager.removeTempDirectory(PathUtils.join(config.tempRootDir, sessionId));
		} catch (error) {
			this.logger.error("Failed to cleanup streaming session", error, { sessionId, reason, mode: session?.mode });
		} finally {
			this.store.delete(sessionId);
			this.softwareFallbackSessions.delete(sessionId);
			this.reservations.release(sessionId);
			this.reservations.unbindUser(sessionId);
			this.bufferCache.invalidate(sessionId);
			this.seeker.cancelSessionLock(sessionId);
			this.playlistWaiter.invalidate(sessionId);
			if (session) {
				this.store.storeTerminated(sessionId, { mediaFileId: session.mediaFileId, profileId: session.profileId }, reason);
				// Lifecycle "ended" mirrors "started" (first successful process attach).
				if (session.generation > 0) {
					try {
						lifecycleCallbacks.onSessionEnded({
							sessionId,
							mediaFileId: session.mediaFileId,
							profileId: session.profileId,
							reason,
						});
					} catch (error) {
						this.logger.error("Playback session end callback failed", error, { sessionId });
					}
				}
			}

			this.logger.debug("Session cleaned up", {
				sessionId,
				reason,
				...(session ? { mode: session.mode, durationMs: Date.now() - session.createdAt } : {}),
			});
		}
	}

	async shutdown(releaseSession: (sessionId: string, reason: string) => Promise<unknown>): Promise<void> {
		this.logger.info("Shutting down streaming system...");

		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		this.seeker.cancelAll("Streaming system is shutting down");

		await PromiseUtils.mapConcurrent(
			this.store.values().map((session) => session.id),
			systemResourcesService.getHeavySubprocessConcurrency(),
			(sessionId) => releaseSession(sessionId, "shutdown"),
		);
		this.store.clear();
		this.reservations.clear();
		this.bufferCache.clear();
		this.playlistWaiter.clear();
	}
}
