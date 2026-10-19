import type { PlaybackDecision } from "@reelvault/sdk/common";
import type { SessionStore } from "@/modules/streaming/runtime/session-state/session.store";
import type { SeekResult } from "@/modules/streaming/streaming.types";
import { clampSeekOffsetToDuration } from "@/modules/streaming/utils/playback-budgets.utils";
import { DomainError } from "@/utils/domain.errors";
import { type SeekExecutor, SeekScheduler } from "./seek.scheduler";

export interface SeekHooks {
	getBufferedSeekStart: (sessionId: string, position: number) => Promise<number | null>;
	keepAlive: (sessionId: string) => void;
}

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
		hooks: SeekHooks,
	): Promise<SeekResult> {
		const { getBufferedSeekStart, keepAlive } = hooks;
		const session = this.store.get(sessionId);
		if (!session) throw new DomainError("not_found", `Session not found: ${sessionId}`, { code: "stream.session_not_found" });

		// The single seek-offset clamp — both explicit API seeks and implicit
		// segment seeks pass through here before the buffered check and alignment.
		const clampedOffset = clampSeekOffsetToDuration(offset, decision.durationSeconds);

		// The buffer may be mid-wipe: a seek/fallback restart in flight holds the
		// session lock, so compute the buffered start only once it settles. A stale
		// "reusedBuffer" answer would leave the client on segments being deleted.
		const bufferedStart = await this.seekScheduler.runExclusive(
			sessionId,
			async () => await getBufferedSeekStart(sessionId, clampedOffset),
		);
		if (bufferedStart !== null) {
			keepAlive(sessionId);
			const result: SeekResult = {
				startTime: session.startTime,
				reusedBuffer: true,
			};
			this.seekScheduler.resolveWithBufferedResult(sessionId, result);

			return result;
		}

		const alignedOffset = this.alignToSegment(clampedOffset, hlsSegmentDuration);
		// An unbuffered seek restarts ffmpeg; it is client activity like any other
		// and must refresh the inactivity clock — otherwise a paused client that
		// scrubs can be reaped mid-seek.
		keepAlive(sessionId);

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
