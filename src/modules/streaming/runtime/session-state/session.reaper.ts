import { join } from "node:path";
import { MINUTE } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { killFfmpegProcessGracefully } from "@/integrations/ffmpeg/ffmpeg.process";
import { ffmpegProcessTracker } from "@/integrations/ffmpeg/ffmpeg.process-tracker";
import type { ProcessManager } from "@/modules/streaming/ffmpeg/process.manager";
import type { PlaylistFileCache } from "@/modules/streaming/playlist/playlist.cache";
import { transcodeProgressMonitor } from "@/modules/streaming/runtime/transcode-progress.monitor";
import type { SessionSeeker } from "@/modules/streaming/seeking/session.seeker";
import type { StreamingLifecycleCallbacks } from "@/modules/streaming/streaming.types";
import { workerJobRepository } from "@/repositories/worker.repository";
import { createLogger } from "@/utils/logger.utils";
import { detach, mapConcurrent } from "@/utils/promise.utils";
import { RecurringTimer } from "@/utils/recurring-timer.utils";
import { isNullish } from "@/utils/type.utils";
import { RESERVATION_DEADLINE_MS, type SessionStore } from "./session.store";
import type { SessionReservationTracker } from "./session-reservation.tracker";

interface SessionReaperDeps {
	store: SessionStore;
	reservations: SessionReservationTracker;
	processManager: Pick<ProcessManager, "removeTempDirectory">;
	playlistFiles: Pick<PlaylistFileCache, "invalidate" | "clear">;
	seeker: SessionSeeker;
	playlistWaiter: { invalidate(id: string): void; clear(): void };
	softwareFallbackSessions: Set<string>;
	implicitSeek: { invalidate(id: string): void };
}

/** Best-effort cleanup step: a failure here must not stop the other cleanup steps. */
async function ignoreFailure(work: Promise<unknown>): Promise<void> {
	try {
		await work;
	} catch {
		/* intentionally empty */
	}
}

export class SessionReaper {
	readonly logger = createLogger(this.constructor.name);
	private cleanupTimer: RecurringTimer | null = null;
	private readonly store: SessionStore;
	private readonly reservations: SessionReservationTracker;
	private readonly processManager: Pick<ProcessManager, "removeTempDirectory">;
	private readonly playlistFiles: Pick<PlaylistFileCache, "invalidate" | "clear">;
	private readonly seeker: SessionSeeker;
	private readonly playlistWaiter: { invalidate(id: string): void; clear(): void };
	private readonly implicitSeek: { invalidate(id: string): void };
	private readonly softwareFallbackSessions: Set<string>;

	constructor(deps: SessionReaperDeps) {
		this.store = deps.store;
		this.reservations = deps.reservations;
		this.processManager = deps.processManager;
		this.playlistFiles = deps.playlistFiles;
		this.seeker = deps.seeker;
		this.playlistWaiter = deps.playlistWaiter;
		this.softwareFallbackSessions = deps.softwareFallbackSessions;
		this.implicitSeek = deps.implicitSeek;
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
		this.cleanupTimer = new RecurringTimer(
			() => {
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
								await mapConcurrent(inactiveIds, systemResourcesService.getHeavySubprocessConcurrency(), (id) =>
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
								const operationIds = candidates
									.map((id) => this.store.get(id)?.operationId)
									.filter((operationId): operationId is string => operationId !== undefined);
								const activeOperations = await workerJobRepository.findActiveOperations(operationIds);
								const staleIds = candidates.filter((id) => {
									const operationId = this.store.get(id)?.operationId;

									return !(operationId && activeOperations.has(operationId));
								});

								if (staleIds.length === 0) return;

								this.logger.warn("Releasing session reservations stuck without a running process", { sessionIds: staleIds });
								await mapConcurrent(staleIds, systemResourcesService.getHeavySubprocessConcurrency(), (id) =>
									releaseSession(id, "reservation-deadline"),
								);
							} catch {
								// releaseSession owns its error reporting; reaping must keep running.
							}
						})(),
					);
				}

				this.store.cleanupTerminatedSessions(5 * MINUTE);
			},
			config.cleanupInterval,
			(error) => {
				this.logger.error("Streaming session reaper tick failed", error);
			},
		);
		this.cleanupTimer.start();
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
		const playback = this.store.playbackOf(sessionId);
		const process = session?.process ?? null;
		if (process) ffmpegProcessTracker.markIntentionalKill(sessionId);

		try {
			let cancelOperation: Promise<void> | undefined;
			if (session?.operationId) {
				cancelOperation = ignoreFailure(lifecycleCallbacks.cancelOperation(session.operationId));
			}
			let releaseProgress: Promise<void> | undefined;
			if (session?.operationId) {
				releaseProgress = transcodeProgressMonitor.onSessionReleased(sessionId, session.operationId);
			}
			let killProcess: Promise<void> | undefined;
			if (process) {
				killProcess = ignoreFailure(killFfmpegProcessGracefully(process));
			}

			await Promise.all([cancelOperation, releaseProgress, killProcess]);
			if (process) ffmpegProcessTracker.forgetStderrTail(process);

			await this.processManager.removeTempDirectory(join(config.tempRootDir, sessionId));
		} catch (error) {
			this.logger.error("Failed to cleanup streaming session", error, { sessionId, reason, mode: session?.mode });
		} finally {
			this.store.delete(sessionId);
			this.softwareFallbackSessions.delete(sessionId);
			this.reservations.release(sessionId);
			this.reservations.unbindUser(sessionId);
			this.playlistFiles.invalidate(sessionId);
			this.seeker.cancelSessionLock(sessionId);
			this.playlistWaiter.invalidate(sessionId);
			this.implicitSeek.invalidate(sessionId);
			if (session) {
				this.store.storeTerminated(sessionId, { mediaFileId: session.mediaFileId, profileId: session.profileId }, reason);
				// Lifecycle "ended" mirrors "started" (first successful process attach).
				if (session.generation > 0) {
					try {
						lifecycleCallbacks.onSessionEnded({
							startedAt: session.createdAt,
							sessionId,
							mediaFileId: session.mediaFileId,
							profileId: session.profileId,
							reason,
							operationId: session.operationId,
							playedSeconds: playback.playedSeconds,
							furthestPositionSeconds: playback.furthestPosition,
							durationSeconds: isNullish(session.durationMs) ? null : Math.round(session.durationMs / 1000),
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

		this.cleanupTimer?.stop();
		this.cleanupTimer = null;

		this.seeker.cancelAll("Streaming system is shutting down");

		await mapConcurrent(
			this.store.values().map((session) => session.id),
			systemResourcesService.getHeavySubprocessConcurrency(),
			(sessionId) => releaseSession(sessionId, "shutdown"),
		);
		this.store.clear();
		this.reservations.clear();
		this.playlistFiles.clear();
		this.playlistWaiter.clear();
	}
}
