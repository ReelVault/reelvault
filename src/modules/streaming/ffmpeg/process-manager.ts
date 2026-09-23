import type { PlaybackDecision, StreamingSession, TranscodeConfig } from "@reelvault/sdk/common";
import { getEffectiveHwaccel } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { killFfmpegProcessGracefully } from "@/integrations/ffmpeg/ffmpeg.process";
import { ffmpegProcessTracker } from "@/integrations/ffmpeg/ffmpeg.process-tracker";
import { DirUtils } from "@/utils/directory.utils";
import { TooManyRequestsError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import type { SessionReservationTracker } from "../runtime/sessions/session-reservation.tracker";
import type { SessionStore } from "../runtime/sessions/session-store";
import { isSoftwareFallbackEligible } from "./software-fallback";
import { createStrategyRegistry } from "./strategies/strategy.factory";

export class ProcessManager {
	private readonly logger = createLogger(this.constructor.name);
	private readonly strategies: ReturnType<typeof createStrategyRegistry>;
	private readonly config: TranscodeConfig;
	private readonly store: SessionStore;
	private readonly reservations: SessionReservationTracker;

	constructor(config: TranscodeConfig, store: SessionStore, reservations: SessionReservationTracker) {
		this.config = config;
		this.store = store;
		this.reservations = reservations;
		this.strategies = createStrategyRegistry(config);
	}

	async startSession(
		sessionId: string,
		session: StreamingSession,
		inputPath: string,
		decision: PlaybackDecision,
		startTime: number,
		timelineStart: number,
		operationId?: string,
	): Promise<void> {
		// Capacity counts sessions that already ran a process; a restart (seek,
		// software fallback) re-enters through here and keeps its reserved slot.
		const isRestart = session.generation > 0;
		if (!isRestart && this.store.attachedCount() >= this.config.maxSessions) {
			throw new TooManyRequestsError(`Concurrent stream limit reached (${this.config.maxSessions})`);
		}

		if (session.process) await this.stopRunningProcess(sessionId, session);

		if (operationId) session.operationId = operationId;

		await this.ensureTempDirectory(session.tempDir);

		const strategy = this.strategies[decision.mode];
		const process = await strategy.startSession(sessionId, inputPath, session.tempDir, decision, startTime);
		try {
			// Atomic: refuses a session whose release was claimed while ffmpeg spawned.
			this.store.attachProcess(sessionId, process, timelineStart);
		} catch (error) {
			await killFfmpegProcessGracefully(process).catch((killError) => {
				this.logger.warn("Failed to kill orphaned ffmpeg during session start rollback", { sessionId, error: killError });
			});
			await process.exited;
			throw error;
		}

		this.reservations.markStarted(sessionId);

		this.logger.info("Session started", { sessionId, inputPath, mode: decision.mode, startTime, timelineStart, reason: decision.reason });
	}

	async stopRunningProcess(sessionId: string, session: StreamingSession, timeoutMs?: number): Promise<void> {
		const process = session.process;
		if (process) {
			await killFfmpegProcessGracefully(process, timeoutMs).catch((killError) => {
				// A failed kill leaves an orphan ffmpeg consuming CPU and writing into
				// a temp dir that is about to be deleted — must be visible.
				this.logger.warn("Failed to kill ffmpeg process gracefully", { sessionId, error: killError });
			});
			await process.exited;
			ffmpegProcessTracker.forgetStderrTail(process);
			this.store.detachProcess(sessionId, process);
		}
	}

	async retryWithSoftwareEncoder(
		sessionId: string,
		session: StreamingSession,
		softwareFallbackSessions: Set<string>,
		prepareSession: (id: string) => Promise<void>,
		startSessionFn: (
			sessionId: string,
			inputPath: string,
			decision: PlaybackDecision,
			startTime: number,
			operationId?: string,
		) => Promise<void>,
	): Promise<boolean> {
		if (softwareFallbackSessions.has(sessionId)) return true;

		if (!isSoftwareFallbackEligible(session.decision, getEffectiveHwaccel().type)) return false;

		softwareFallbackSessions.add(sessionId);
		// Persist the fallback so diagnostics/live-activity report the software
		// decision and a later retry is not considered eligible again.
		this.store.setDecision(sessionId, { ...session.decision, forceSoftware: true });
		this.logger.warn("Hardware encode failed before the first segment — retrying with the software encoder", {
			sessionId,
			exitCode: session.process?.exitCode,
		});
		try {
			await prepareSession(sessionId);
			await startSessionFn(sessionId, session.inputPath, session.decision, session.startTime, session.operationId);

			return true;
		} catch (error) {
			// Clear the one-shot guard so a transient failure does not permanently
			// mark the session as "already falling back".
			softwareFallbackSessions.delete(sessionId);
			this.logger.error("Software encoder fallback failed", error, { sessionId });

			return false;
		}
	}

	async ensureTempDirectory(dirPath: string): Promise<void> {
		await this.removeTempDirectory(dirPath);
		await DirUtils.create(dirPath);
	}

	async removeTempDirectory(dirPath: string): Promise<void> {
		if (await DirUtils.exists(dirPath)) {
			await DirUtils.deleteTemporary(dirPath);
		}
	}
}
