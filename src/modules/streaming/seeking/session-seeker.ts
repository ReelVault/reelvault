import type { PlaybackDecision } from "@reelvault/sdk/common";
import { NotFoundError } from "@/utils/errors";
import type { SessionStore } from "../runtime/sessions/session-store";
import type { SeekResult } from "../streaming.types";
import { clampSeekOffsetToDuration } from "../utils/playback-budgets";
import { type SeekExecutor, SeekScheduler } from "./seek.scheduler";

export class SessionSeeker {
	private readonly seekScheduler: SeekScheduler;
	private readonly store: SessionStore;

	constructor(store: SessionStore, debounceMs: number, execute: SeekExecutor) {
		this.store = store;
		this.seekScheduler = new SeekScheduler(debounceMs, execute);
	}

	async seekTo(
		sessionId: string,
		offset: number,
		decision: PlaybackDecision,
		hlsSegmentDuration: number,
		getBufferedSeekStart: (sessionId: string, position: number) => Promise<number | null>,
		keepAlive: (sessionId: string) => void,
	): Promise<SeekResult> {
		const session = this.store.get(sessionId);
		if (!session) throw new NotFoundError(`Session not found: ${sessionId}`);

		const bufferedStart = await getBufferedSeekStart(sessionId, offset);
		if (bufferedStart !== null) {
			keepAlive(sessionId);
			const result: SeekResult = {
				startTime: session.startTime,
				reusedBuffer: true,
			};
			this.seekScheduler.resolveWithBufferedResult(sessionId, result);

			return result;
		}

		const clampedOffset = clampSeekOffsetToDuration(offset, decision.durationSeconds);
		const alignedOffset = this.alignToSegment(clampedOffset, hlsSegmentDuration);

		return this.seekScheduler.schedule(sessionId, alignedOffset, decision);
	}

	isSessionSeeking(sessionId: string): boolean {
		return this.seekScheduler.isSeeking(sessionId);
	}

	/** Serializes a non-seek session restart (software fallback) with in-flight seeks. */
	runExclusive<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
		return this.seekScheduler.runExclusive(sessionId, task);
	}

	alignToSegment(position: number, hlsSegmentDuration: number): number {
		return Math.floor(Math.max(0, position) / hlsSegmentDuration) * hlsSegmentDuration;
	}

	cancelAll(reason: string): void {
		this.seekScheduler.cancelAll(reason);
	}

	cancelSessionLock(sessionId: string): void {
		this.seekScheduler.cancelSessionLock(sessionId);
	}
}
