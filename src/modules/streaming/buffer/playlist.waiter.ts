import type { StreamingSession } from "@reelvault/sdk/common";
import { sleep } from "bun";
import { systemResourcesService } from "@/config/system-resources.service";
import { playlistFileCache } from "@/modules/streaming/playlist/playlist.cache";
import type { SessionStore } from "@/modules/streaming/runtime/session-state/session.store";
import type { SessionReservationTracker } from "@/modules/streaming/runtime/session-state/session-reservation.tracker";
import { PLAYLIST_FILE_NAME } from "@/modules/streaming/utils/segment-name.utils";
import { DomainError } from "@/utils/domain.errors";
import { FileUtils } from "@/utils/file.utils";
import { PromiseUtils } from "@/utils/promise.utils";

export class PlaylistWaiter {
	private readonly cushionedSessions = new Set<string>();
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

		if (!(await FileUtils.exists(playlistPath))) {
			let session = this.store.get(sessionId);
			const exitCode = session?.process?.exitCode ?? null;
			if (session && exitCode != null) {
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
			const exitPromise: Promise<never> = processHandle
				? (async () => {
						const code = await processHandle.exited;
						throw new DomainError("internal", `Streaming process exited before creating the playlist (exit code ${code})`, {
							code: "streaming_process_exited",
						});
					})()
				: new Promise<never>(() => {
						// intentionally empty — promise never resolves (no exit event to handle)
					});

			try {
				// fs.watch drives the wake-up; the tick below is only the fallback when
				// no watcher can be created — keep it tight, it sits on playback start.
				await Promise.race([PromiseUtils.waitForFile(playlistPath, timeoutMs, 25, signal), exitPromise]);
			} catch (error) {
				if (error instanceof DomainError && error.category === "timeout") {
					throw new DomainError("timeout", `Playlist was not generated within ${timeoutMs}ms`, { code: "playlist_generation_timeout" });
				}

				throw error;
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

			if (session.process?.exitCode != null) break;

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

		this.cushionedSessions.add(sessionId);
	}

	invalidate(sessionId: string): void {
		this.cushionedSessions.delete(sessionId);
	}

	clear(): void {
		this.cushionedSessions.clear();
	}
}
