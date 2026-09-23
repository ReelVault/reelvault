import type { StreamingSession } from "@reelvault/sdk/common";
import { workerOperationRepository } from "@/database/repositories/worker-operation.repository";
import type { FFmpegProgress } from "@/integrations/ffmpeg/ffmpeg.builder";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math.utils";
import type { SessionStore } from "./sessions/session-store";

const logger = createLogger("TranscodeProgressMonitor");

/** Mirrors the worker pool's progress-write throttle: one DB write per second per stream. */
const PROGRESS_WRITE_MIN_INTERVAL_MS = 1_000;

export interface TranscodeProgressMonitorDependencies {
	attachStreamOperation(operationId: string): Promise<void>;
	updateOperationProgress(operationId: string, percent: number): Promise<void>;
	completeStreamOperation(operationId: string): Promise<void>;
	releaseStreamOperation(operationId: string): Promise<void>;
}

const defaultDependencies: TranscodeProgressMonitorDependencies = {
	attachStreamOperation: (operationId) => workerOperationRepository.markStreamAttached(operationId),
	updateOperationProgress: (operationId, percent) => workerOperationRepository.updateProgress(operationId, percent),
	completeStreamOperation: (operationId) => workerOperationRepository.completeStreamSlot(operationId),
	releaseStreamOperation: (operationId) => workerOperationRepository.releaseStreamSlot(operationId),
};

/**
 * Turns ffmpeg's stderr stats lines (`time=…`, `speed=…`, already parsed by
 * FFmpegBuilder) into live progress for a streaming session: the session entity
 * carries the position for diagnostics/live-activity, and the `streaming-session`
 * worker operation stays "running" with a real percent until the encode ends —
 * instead of vanishing after the seconds-long stream-init job.
 *
 * The slot accounting (`markStreamAttached` / release / complete) lives in the
 * operation repository and is idempotent, so seek restarts never double-count.
 */
export class TranscodeProgressMonitor {
	private store: SessionStore | null = null;
	private readonly lastWrites = new Map<string, { at: number; percent: number }>();
	/** Sessions that already hold a streaming slot — guards seek/fallback restarts from double-claiming. */
	private readonly attachedSessions = new Set<string>();
	private readonly dependencies: TranscodeProgressMonitorDependencies;

	constructor(dependencies: TranscodeProgressMonitorDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	/** Called once by the streaming service so the monitor can see session entities. */
	attachStore(store: SessionStore): void {
		this.store = store;
	}

	/** A process was attached to the session — take the operation's streaming slot (best-effort). */
	async onProcessAttached(sessionId: string): Promise<void> {
		const session = this.store?.get(sessionId);
		if (!session?.operationId) return;

		// The slot is held for the whole session; a seek/fallback restart must not
		// claim it again. Released on EOF or session teardown below.
		if (this.attachedSessions.has(sessionId)) return;

		this.attachedSessions.add(sessionId);
		try {
			await this.dependencies.attachStreamOperation(session.operationId);
		} catch (error) {
			this.attachedSessions.delete(sessionId);
			logger.warn("Could not attach the streaming slot to its operation", { sessionId, operationId: session.operationId, error });
		}
	}

	/** ffmpeg stats line — updates the session entity and (throttled) the operation percent. */
	async onFfmpegProgress(sessionId: string, progress: FFmpegProgress): Promise<void> {
		const store = this.store;
		const session = store?.get(sessionId);
		if (!(store && session) || session.state === "ending") return;

		const positionMs = parseTimeToMs(progress.time);
		if (positionMs === null) return;

		const percent =
			session.durationMs !== null && session.durationMs > 0 ? clamp(Math.round((positionMs / session.durationMs) * 100), 0, 100) : null;
		store.setTranscodeProgress(sessionId, { positionMs, percent, speed: progress.speed });

		await this.writeOperationProgress(session, percent);
	}

	/**
	 * ffmpeg exited. A natural EOF (exit 0, no signal) closes the operation as
	 * completed at 100%; a kill (seek restart, release) leaves the slot with the
	 * session — either a restart re-uses it or the reaper finalizes it.
	 */
	async onFfmpegExit(sessionId: string, exitCode: number | null, signalCode: number | null): Promise<void> {
		const store = this.store;
		const session = store?.get(sessionId);
		if (!(store && session)) return;

		if (exitCode !== 0 || signalCode != null) return;

		const operationId = session.operationId;
		this.lastWrites.delete(sessionId);
		this.attachedSessions.delete(sessionId);
		store.setTranscodeProgress(sessionId, {
			positionMs: session.durationMs ?? session.transcodePositionMs ?? 0,
			percent: 100,
			speed: session.transcodeSpeed,
		});
		if (!operationId) return;

		try {
			await this.dependencies.completeStreamOperation(operationId);
		} catch (error) {
			logger.warn("Could not complete the streaming operation on EOF", { sessionId, operationId, error });
		}
	}

	/** Session teardown — drop throttle state and release the slot the process may still hold. */
	async onSessionReleased(sessionId: string, operationId?: string): Promise<void> {
		this.lastWrites.delete(sessionId);
		this.attachedSessions.delete(sessionId);
		if (!operationId) return;

		try {
			await this.dependencies.releaseStreamOperation(operationId);
		} catch (error) {
			logger.warn("Could not release the streaming slot", { sessionId, operationId, error });
		}
	}

	private async writeOperationProgress(session: StreamingSession, percent: number | null): Promise<void> {
		if (percent === null || !session.operationId) return;

		const last = this.lastWrites.get(session.id);
		// Same percent means nothing to persist; a changed one is throttled to one
		// write per second — except 100, which must always land.
		if (last?.percent === percent) return;

		const now = Date.now();
		if (last && now - last.at < PROGRESS_WRITE_MIN_INTERVAL_MS && percent !== 100) return;

		this.lastWrites.set(session.id, { at: now, percent });
		try {
			await this.dependencies.updateOperationProgress(session.operationId, percent);
		} catch {
			// Progress reporting is best-effort; playback must never depend on it.
		}
	}
}

/** Parses ffmpeg's `time=HH:MM:SS.micro` (also bare `MM:SS.micro`) into milliseconds. */
export function parseTimeToMs(time: string): number | null {
	const parts = time.trim().split(":");
	if (parts.length < 2 || parts.length > 3) return null;

	const seconds = Number.parseFloat(parts[parts.length - 1] ?? "");
	const minutes = Number.parseInt(parts[parts.length - 2] ?? "", 10);
	const hours = parts.length === 3 ? Number.parseInt(parts[0] ?? "", 10) : 0;
	if (!(Number.isFinite(seconds) && Number.isFinite(minutes) && Number.isFinite(hours))) return null;

	return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

export const transcodeProgressMonitor = new TranscodeProgressMonitor();
