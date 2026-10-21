import type { PlaybackDecision, StreamingSession, TranscodeConfig } from "@reelvault/sdk/common";
import { serverConstants } from "@/config/server/server.constants";
import { getEffectiveHwaccel } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { killFfmpegProcessGracefully, waitForExitWithTimeout } from "@/integrations/ffmpeg/ffmpeg.process";
import { ffmpegProcessTracker } from "@/integrations/ffmpeg/ffmpeg.process-tracker";
import type { SessionStore } from "@/modules/streaming/runtime/session-state/session.store";
import type { SessionReservationTracker } from "@/modules/streaming/runtime/session-state/session-reservation.tracker";
import { createDirectory, deleteTemporaryDirectory, directoryExists } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { isSoftwareFallbackEligible } from "./software-fallback.policy";
import { createStrategyRegistry } from "./strategies/strategy.factory";

interface ProcessStartInput {
	sessionId: string;
	session: StreamingSession;
	inputPath: string;
	decision: PlaybackDecision;
	startTime: number;
	timelineStart: number;
	operationId?: string | undefined;
}

export class ProcessManager {
	readonly logger = createLogger(this.constructor.name);
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

	async startSession({ sessionId, session, inputPath, decision, startTime, timelineStart, operationId }: ProcessStartInput): Promise<void> {
		// Capacity counts sessions that already ran a process; a restart (seek,
		// software fallback) re-enters through here and keeps its reserved slot.
		const isRestart = session.generation > 0;
		if (!isRestart && this.store.attachedCount() >= this.config.maxSessions) {
			throw new DomainError("too_many_requests", `Concurrent stream limit reached (${this.config.maxSessions})`, {
				code: "stream.limit_reached",
				params: {
					scope: "server",
					limit: this.config.maxSessions,
					active: this.store.attachedCount(),
					retryAfterSeconds: serverConstants.stream.sessionLimitRetryAfterSeconds,
				},
			});
		}

		if (session.process) await this.stopRunningProcess(sessionId, session);

		if (operationId) session.operationId = operationId;

		await this.ensureTempDirectory(session.tempDir);

		const strategy = this.strategies[decision.mode];
		const process = await strategy.startSession({
			sessionId,
			inputPath,
			outputDir: session.tempDir,
			decision,
			startTime,
			operationId: session.operationId,
		});
		try {
			// Atomic: refuses a session whose release was claimed while ffmpeg spawned.
			this.store.attachProcess(sessionId, process, timelineStart);
		} catch (error) {
			ffmpegProcessTracker.markIntentionalKill(sessionId);
			await killFfmpegProcessGracefully(process).catch((killError: unknown) => {
				this.logger.warn("Failed to kill orphaned ffmpeg during session start rollback", { sessionId, error: killError });
			});
			await waitForExitWithTimeout(process);
			throw error;
		}

		this.reservations.markStarted(sessionId);

		this.logger.info("Session started", { sessionId, inputPath, mode: decision.mode, startTime, timelineStart, reason: decision.reason });
	}

	async stopRunningProcess(sessionId: string, session: StreamingSession, timeoutMs?: number): Promise<void> {
		const process = session.process;
		if (process) {
			ffmpegProcessTracker.markIntentionalKill(sessionId);
			await killFfmpegProcessGracefully(process, timeoutMs).catch((killError: unknown) => {
				// A failed kill leaves an orphan ffmpeg consuming CPU and writing into
				// a temp dir that is about to be deleted — must be visible.
				this.logger.warn("Failed to kill ffmpeg process gracefully", { sessionId, error: killError });
			});
			await waitForExitWithTimeout(process);
			ffmpegProcessTracker.forgetStderrTail(process);
			this.store.detachProcess(sessionId, process);
		}
	}

	async retryWithSoftwareEncoder(options: {
		sessionId: string;
		session: StreamingSession;
		softwareFallbackSessions: Set<string>;
		prepareSession: (sessionId: string) => Promise<void>;
		startSession: (sessionId: string, session: StreamingSession) => Promise<void>;
	}): Promise<boolean> {
		const { sessionId, session, softwareFallbackSessions, prepareSession, startSession } = options;

		if (softwareFallbackSessions.has(sessionId)) return true;

		if (!isSoftwareFallbackEligible(session.decision, getEffectiveHwaccel().type)) return false;

		softwareFallbackSessions.add(sessionId);
		// Persist the fallback so diagnostics/live-activity report the software
		// decision and a later retry is not considered eligible again.
		this.store.setDecision(sessionId, { ...session.decision, forceSoftware: true });
		this.store.markSoftwareVideoSession(sessionId);
		this.logger.warn("Hardware encode failed before the first segment — retrying with the software encoder", {
			sessionId,
			exitCode: session.process?.exitCode,
		});
		try {
			await prepareSession(sessionId);
			await startSession(sessionId, session);

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
		await createDirectory(dirPath);
	}

	async removeTempDirectory(dirPath: string): Promise<void> {
		if (await directoryExists(dirPath)) {
			await deleteTemporaryDirectory(dirPath);
		}
	}
}
