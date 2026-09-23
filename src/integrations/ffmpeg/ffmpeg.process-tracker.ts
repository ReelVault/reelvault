import { createLogger } from "@/utils/logger";
import { detach } from "@/utils/promise.utils";

const logger = createLogger("FFmpegProcessTracker");

/** Safety bound for retained streaming stderr tails (normally dropped per session teardown). */
const MAX_STDERR_TAILS = 64;

/**
 * "streaming" processes serve active playback sessions and must never be killed
 * by the server rescue system; "background" processes (scans, plugins, loudness,
 * subtitles, integrity checks) are expendable under rescue pressure. "probe"
 * (ffprobe) and "diagnostic" (capability detection) runs are short-lived and
 * tracked so the admin surface can account for every child process.
 */

export type FfmpegProcessPurpose = "streaming" | "background" | "probe" | "diagnostic";

export interface TrackedProcess {
	readonly pid?: number | undefined;
	readonly exited: Promise<number>;
	kill(signal?: string | number): void;
}

export interface TrackedProcessSnapshot {
	readonly pid: number | null;
	readonly purpose: FfmpegProcessPurpose;
	readonly label: string | null;
	readonly startedAt: Date;
	readonly runtimeMs: number;
}

export interface ProcessCounts extends Record<FfmpegProcessPurpose, number> {
	readonly total: number;
}

interface ProcessMeta {
	readonly purpose: FfmpegProcessPurpose;
	readonly label: string | null;
	readonly startedAt: Date;
}

class FFmpegProcessTracker {
	private readonly processes = new Map<TrackedProcess, ProcessMeta>();
	/** Stderr tail providers keyed by process — read when a process dies unexpectedly. */
	private readonly stderrTails = new Map<TrackedProcess, () => string>();
	/** Labels of processes killed on purpose (session stop, shutdown, rescue) — exit logging downgrades these. */
	private readonly intentionalKillLabels = new Set<string>();
	/** Streaming slots claimed but not yet tracked (spawn in progress) — keeps thread budgeting honest. */
	private pendingStreaming = 0;

	constructor() {
		const killAllHandler = () => {
			this.killAll();
		};

		process.on("exit", killAllHandler);
		process.on("SIGINT", killAllHandler);
		process.on("SIGTERM", killAllHandler);
	}

	/**
	 * Reserves a streaming slot before spawning so two concurrent starts cannot
	 * both read the same count and oversubscribe the thread budget. Release once
	 * `track` has been called (or on failure).
	 */
	reserveStreaming(): () => void {
		this.pendingStreaming++;
		let released = false;

		return () => {
			if (released) return;

			released = true;
			this.pendingStreaming--;
		};
	}

	countByPurpose(purpose: FfmpegProcessPurpose): number {
		if (purpose === "streaming") return this.countEntries("streaming") + this.pendingStreaming;

		return this.countEntries(purpose);
	}

	track(process: TrackedProcess, purpose: FfmpegProcessPurpose = "background", stderrTail?: () => string, label?: string): void {
		this.processes.set(process, { purpose, label: label ?? null, startedAt: new Date() });
		if (stderrTail) {
			if (this.stderrTails.size >= MAX_STDERR_TAILS) {
				const oldest = this.stderrTails.keys().next().value;
				if (oldest !== undefined) this.stderrTails.delete(oldest);
			}

			this.stderrTails.set(process, stderrTail);
		}

		detach(
			(async () => {
				try {
					await process.exited;
				} catch {
					// Exit settlement is enough; exit errors are owned by the runner.
				} finally {
					this.processes.delete(process);
					// Background tails are diagnostics for the immediate failure path only —
					// nothing calls forgetStderrTail for them, so drop on exit to avoid a leak.
					// Streaming tails are intentionally kept until the session is torn down.
					if (purpose === "background") this.stderrTails.delete(process);
				}
			})(),
		);
	}

	/** Point-in-time view of every live child process, for admin diagnostics. */
	listProcesses(): TrackedProcessSnapshot[] {
		const now = Date.now();

		return [...this.processes.entries()].map(([process, meta]) => ({
			pid: process.pid ?? null,
			purpose: meta.purpose,
			label: meta.label,
			startedAt: meta.startedAt,
			runtimeMs: Math.max(0, now - meta.startedAt.getTime()),
		}));
	}

	counts(): ProcessCounts {
		const counts = { streaming: this.pendingStreaming, background: 0, probe: 0, diagnostic: 0, total: 0 };
		for (const meta of this.processes.values()) counts[meta.purpose]++;

		counts.total = counts.streaming + counts.background + counts.probe + counts.diagnostic;

		return counts;
	}

	/**
	 * Last stderr lines of a (typically crashed) ffmpeg process. The provider
	 * stays readable after the process exits; drop it with forgetStderrTail once
	 * the session entry is gone.
	 */
	getStderrTail(process: TrackedProcess): string | undefined {
		return this.stderrTails.get(process)?.();
	}

	forgetStderrTail(process: TrackedProcess): void {
		this.stderrTails.delete(process);
	}

	/**
	 * Registers a label whose next non-zero exit is an expected teardown, not a
	 * crash — the runner logs it as a warning instead of an error. The mark is
	 * consumed by `clearIntentionalKill` once the exit was observed.
	 */
	markIntentionalKill(label: string | null | undefined): void {
		if (label) this.intentionalKillLabels.add(label);
	}

	isIntentionalKill(label: string | null | undefined): boolean {
		return label != null && this.intentionalKillLabels.has(label);
	}

	clearIntentionalKill(label: string | null | undefined): void {
		if (label) this.intentionalKillLabels.delete(label);
	}

	killAll(): void {
		if (this.processes.size === 0) return;

		logger.warn(`Terminating ${this.processes.size} active FFmpeg/ffprobe process(es)`);
		for (const [tracked, meta] of this.processes) {
			this.markIntentionalKill(meta.label);
			try {
				tracked.kill("SIGKILL");
			} catch {
				// Process might already be terminated
			}
		}

		this.processes.clear();
		this.stderrTails.clear();
	}

	/** Kills only background FFmpeg processes, leaving active playback sessions untouched. */
	killAllBackground(): number {
		const victims = [...this.processes.entries()].filter(([, meta]) => meta.purpose === "background");
		if (victims.length === 0) return 0;

		logger.warn(`Rescue: terminating ${victims.length} background FFmpeg process(es)`);
		for (const [tracked, meta] of victims) {
			this.markIntentionalKill(meta.label);
			try {
				tracked.kill("SIGKILL");
			} catch {
				// Process might already be terminated
			}

			this.processes.delete(tracked);
		}

		return victims.length;
	}

	get activeCount(): number {
		return this.processes.size;
	}

	get backgroundCount(): number {
		return this.countEntries("background");
	}

	private countEntries(purpose: FfmpegProcessPurpose): number {
		let total = 0;
		for (const meta of this.processes.values()) {
			if (meta.purpose === purpose) total++;
		}

		return total;
	}
}

export const ffmpegProcessTracker = new FFmpegProcessTracker();
