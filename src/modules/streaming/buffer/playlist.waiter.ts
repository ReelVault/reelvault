import type { StreamingSession } from "@reelvault/sdk/common";
import { sleep } from "bun";
import { systemResourcesService } from "@/config/system-resources.service";
import { playlistFileCache } from "@/modules/streaming/playlist/playlist.cache";
import type { SessionStore } from "@/modules/streaming/runtime/session-state/session.store";
import type { SessionReservationTracker } from "@/modules/streaming/runtime/session-state/session-reservation.tracker";
import { PLAYLIST_FILE_NAME } from "@/modules/streaming/utils/segment-name.utils";
import { DomainError } from "@/utils/domain.errors";
import { fileExists } from "@/utils/file.utils";
import { waitForFile } from "@/utils/promise.utils";
import { isNullish } from "@/utils/type.utils";

/** Placeholder unregister used until `registerWaiter` replaces it synchronously (no await in between). */
const noopUnregister = () => {
	// intentionally empty
};

export class PlaylistWaiter {
	private readonly cushionedSessions = new Set<string>();
	/** In-flight playlist waits per session, so a release fails them instead of polling a deleted directory. */
	private readonly waiters = new Map<string, Set<(error: DomainError) => void>>();
	private readonly store: SessionStore;
	private readonly reservations: SessionReservationTracker;
	private readonly getFilePath: (sessionId: string, fileName: string) => string;
	private readonly hlsSegmentDuration: number;

	constructor(
		store: SessionStore,
		reservations: SessionReservationTracker,
		getFilePath: (sessionId: string, fileName: string) => string,
		hlsSegmentDuration: number,
	) {
		this.store = store;
		this.reservations = reservations;
		this.getFilePath = getFilePath;
		this.hlsSegmentDuration = hlsSegmentDuration;
	}

	async waitForPlaylist(
		sessionId: string,
		timeoutMs: number,
		retryWithSoftwareEncoder: (sessionId: string, session: StreamingSession) => Promise<boolean>,
		signal?: AbortSignal,
	): Promise<void> {
		const playlistPath = this.getFilePath(sessionId, PLAYLIST_FILE_NAME);

		if (!(await fileExists(playlistPath))) {
			let session = this.store.get(sessionId);
			const exitCode = session?.process?.exitCode ?? null;
			if (session && !isNullish(exitCode)) {
				const restarted = await retryWithSoftwareEncoder(sessionId, session);
				if (!restarted) {
					throw new DomainError("internal", `Streaming process exited before creating the playlist (exit code ${exitCode})`, {
						code: "streaming_process_exited",
					});
				}

				session = this.store.get(sessionId);
			}

			if (!(session || this.reservations.isPending(sessionId))) {
				throw new DomainError("internal", "Streaming process was not started", { code: "streaming_process_not_started" });
			}

			const processHandle = session?.process;
			let exitPromise: Promise<never>;
			if (processHandle) {
				exitPromise = (async () => {
					const code = await processHandle.exited;
					throw new DomainError("internal", `Streaming process exited before creating the playlist (exit code ${code})`, {
						code: "streaming_process_exited",
					});
				})();
			} else {
				exitPromise = new Promise<never>(() => {
					// intentionally empty — promise never resolves (no exit event to handle)
				});
			}

			let unregister = noopUnregister;
			const cancelled = new Promise<never>((_resolve, reject) => {
				unregister = this.registerWaiter(sessionId, reject);
			});

			try {
				// fs.watch drives the wake-up; the tick below is only the fallback when
				// no watcher can be created — keep it tight, it sits on playback start.
				await Promise.race([waitForFile(playlistPath, timeoutMs, 25, signal), exitPromise, cancelled]);
			} catch (error) {
				if (error instanceof DomainError && error.category === "timeout") {
					throw new DomainError("timeout", `Playlist was not generated within ${timeoutMs}ms`, {
						cause: error,
						code: "playlist_generation_timeout",
					});
				}

				throw error;
			} finally {
				unregister();
			}
		}

		await this.waitForInitialPlaylistCushion(sessionId, playlistPath, signal);
	}

	private async waitForInitialPlaylistCushion(sessionId: string, playlistPath: string, signal?: AbortSignal): Promise<void> {
		const session = this.store.get(sessionId);
		if (!session) return;

		if (this.cushionedSessions.has(sessionId)) return;

		const targetSegments = 2;
		const targetBufferedSeconds = targetSegments * this.hlsSegmentDuration;
		const cushionDeadline = Date.now() + systemResourcesService.scaledTimeoutMs(2_000);
		while (Date.now() < cushionDeadline) {
			if (signal?.aborted) return;

			if (!isNullish(session.process?.exitCode)) break;

			try {
				// The shared cache dedupes the stat+read+parse per (mtime, size), so an
				// unchanged playlist between ticks costs one stat instead of a full
				// read and parse — and the following playlist request reuses the views.
				const result = await playlistFileCache.read(sessionId, playlistPath, this.hlsSegmentDuration);
				if (
					result.ok &&
					(result.analysis.complete ||
						result.analysis.bufferedSeconds >= targetBufferedSeconds ||
						result.analysis.segments.length >= targetSegments)
				) {
					break;
				}
			} catch {
				// Playlist may be in the middle of being updated on disk
			}

			// The playlist is written one segment at a time (seconds apart), so a
			// 100 ms poll catches a new segment promptly while doing ~5× fewer stat
			// calls than the previous 20 ms tick over the 2 s cushion window.
			await sleep(100);
		}

		if (this.store.get(sessionId)) this.cushionedSessions.add(sessionId);
	}

	/** Fails every playlist wait of this session, so a release answers immediately instead of polling. */
	invalidate(sessionId: string): void {
		this.cushionedSessions.delete(sessionId);
		const waiters = this.waiters.get(sessionId);
		if (!waiters) return;

		this.waiters.delete(sessionId);
		for (const reject of waiters) {
			reject(new DomainError("not_found", "Streaming session ended while waiting for its playlist", { code: "stream.session_not_found" }));
		}
	}

	private registerWaiter(sessionId: string, reject: (error: DomainError) => void): () => void {
		const waiters = this.waiters.get(sessionId) ?? new Set<(error: DomainError) => void>();
		waiters.add(reject);
		this.waiters.set(sessionId, waiters);

		return () => {
			waiters.delete(reject);
			if (waiters.size === 0) this.waiters.delete(sessionId);
		};
	}

	clear(): void {
		this.cushionedSessions.clear();
		this.waiters.clear();
	}
}
