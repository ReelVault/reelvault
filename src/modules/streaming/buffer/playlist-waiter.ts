import type { StreamingSession } from "@sdk/common/stream.types";
import { systemResourcesService } from "@/system/system-resources.service";
import { InternalError, RequestTimeoutError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import type { SessionReservationTracker } from "../runtime/sessions/session-reservation.tracker";
import type { SessionStore } from "../runtime/sessions/session-store";
import { parseHlsBuffer } from "./hls-buffer";

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
		const playlistPath = this.getFilePath(sessionId, "playlist.m3u8");

		if (!(await FileUtils.exists(playlistPath))) {
			let session = this.store.get(sessionId);
			const exitCode = session?.process?.exitCode ?? null;
			if (session && exitCode != null) {
				const restarted = await retryWithSoftwareEncoder(sessionId, session);
				if (!restarted) {
					throw new InternalError(`Streaming process exited before creating the playlist (exit code ${exitCode})`, {
						code: "streaming_process_exited",
					});
				}

				session = this.store.get(sessionId);
			}

			if (!(session || this.reservations.isPending(sessionId))) {
				throw new InternalError("Streaming process was not started", { code: "streaming_process_not_started" });
			}

			const processHandle = session?.process;
			const exitPromise: Promise<never> = processHandle
				? (async () => {
						const code = await processHandle.exited;
						throw new InternalError(`Streaming process exited before creating the playlist (exit code ${code})`, {
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
				if (error instanceof Error && error.message.includes("did not appear within")) {
					throw new RequestTimeoutError(`Playlist was not generated within ${timeoutMs}ms`, { code: "playlist_generation_timeout" });
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
				const text = await FileUtils.get(playlistPath).text();
				const analysis = parseHlsBuffer(text, this.hlsSegmentDuration);
				if (analysis.complete || analysis.bufferedSeconds >= targetBufferedSeconds || analysis.segments.length >= targetSegments) {
					break;
				}
			} catch {
				// Playlist may be in the middle of being updated on disk
			}

			await PromiseUtils.sleep(20);
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
