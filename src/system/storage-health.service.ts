import { readFileSync } from "node:fs";
import { parse, resolve, sep } from "node:path";
import { DAY, MINUTE } from "@/config/server/server.constants";
import { createLogger } from "@/utils/logger.utils";

/** Failures the background media paths can record against a file or its storage. */
export type StorageFailureReason =
	| "frame_timeout"
	| "frame_error"
	| "grid_timeout"
	| "grid_error"
	| "empty_sprite"
	| "read_timeout"
	| "io_error";

interface FileHealth {
	failures: number;
	firstFailureAt: number;
	lastFailureAt: number;
	blockedUntil: number;
	reason: StorageFailureReason;
}

interface RootHealth {
	failures: number;
	firstFailureAt: number;
	lastFailureAt: number;
	degradedUntil: number;
	reason: StorageFailureReason;
	/** Distinct files that failed on this root inside the failure window. */
	files: Set<string>;
}

interface FailureHistory {
	failures: number;
	firstFailureAt: number;
	lastFailureAt: number;
}

export interface DegradedStorageRoot {
	root: string;
	failures: number;
	distinctFiles: number;
	reason: StorageFailureReason;
	remainingMs: number;
}

export interface BlockedStorageFile {
	path: string;
	failures: number;
	reason: StorageFailureReason;
	remainingMs: number;
}

export interface StorageHealthSnapshot {
	degradedRoots: DegradedStorageRoot[];
	blockedFiles: BlockedStorageFile[];
}

interface StorageHealthDependencies {
	/** Test seam: a controllable clock. */
	now?: (() => number) | undefined;
	/** Test seam: the mount points a path is resolved against. */
	mounts?: (() => string[]) | undefined;
}

/** A file that keeps timing out is skipped for this long instead of being retried on every scan. */
const FILE_BLOCK_MS = DAY;
/** A root needs this many failures, from this many distinct files, before it is degraded. */
const ROOT_FAILURE_THRESHOLD = 5;
const ROOT_DISTINCT_FILE_THRESHOLD = 3;
/** The failure window: old counts age out, so one bad evening does not poison a healthy mount forever. */
const FAILURE_WINDOW_MS = 10 * MINUTE;
/** How long a degraded root is skipped before a probe is allowed again. */
const ROOT_DEGRADED_MS = 15 * MINUTE;
/** The mount table changes rarely; re-reading it on every file check is pointless. */
const MOUNT_CACHE_MS = MINUTE;
const MAX_TRACKED_FILES = 2_000;
const MAX_TRACKED_ROOTS = 64;
/** Distinct failing files kept per root; only the count threshold matters. */
const MAX_ROOT_FAILURE_FILES = 100;
/** A full expiry sweep walks every tracked file; a burst of failures must not make it O(n²). */
const EXPIRY_SWEEP_MS = 30_000;

/** The shared failure-count window: a recent prior failure extends the streak, otherwise it restarts. */
function countFailure(
	previous: FailureHistory | undefined,
	now: number,
): { recentlyFailed: boolean; failures: number; firstFailureAt: number } {
	const recentlyFailed = previous !== undefined && now - previous.lastFailureAt <= FAILURE_WINDOW_MS;

	return {
		recentlyFailed,
		failures: recentlyFailed ? previous.failures + 1 : 1,
		firstFailureAt: recentlyFailed ? previous.firstFailureAt : now,
	};
}

let cachedMounts: { readAt: number; points: string[] } | undefined;

function decodeMountPoint(value: string): string {
	return value
		.replaceAll(String.raw`\040`, " ")
		.replaceAll(String.raw`\011`, "\t")
		.replaceAll(String.raw`\012`, "\n")
		.replaceAll(String.raw`\134`, "\\");
}

/** Mount points from `/proc/mounts`; an empty list on platforms without that file. */
function readMountPoints(): string[] {
	try {
		const content = readFileSync("/proc/mounts", "utf8");
		const points: string[] = [];
		for (const line of content.split("\n")) {
			const fields = line.split(" ");
			const mountPoint = fields[1];
			if (mountPoint) points.push(decodeMountPoint(mountPoint));
		}

		return points;
	} catch {
		return [];
	}
}

function defaultMounts(): string[] {
	const now = Date.now();
	if (cachedMounts && now - cachedMounts.readAt < MOUNT_CACHE_MS) return cachedMounts.points;

	const points = readMountPoints();
	cachedMounts = { readAt: now, points };

	return points;
}

/** The longest configured mount point that contains `path`, or the filesystem root. */
export function resolveStorageRoot(path: string, mounts: readonly string[]): string {
	const resolved = resolve(path);
	let best = parse(resolved).root;

	for (const mount of mounts) {
		if (mount.length <= best.length) continue;

		const prefix = mount.endsWith(sep) ? mount : `${mount}${sep}`;
		if (resolved === mount || resolved.startsWith(prefix)) best = mount;
	}

	return best;
}

/**
 * Remembers which files and mounts fail media reads, so a dead dataset is
 * skipped instead of spawning another ffmpeg for every file on it.
 *
 * Per-file blocks are the precise guard: a single bad file never condemns a
 * whole library. A root is degraded only after several distinct files fail,
 * which is the signature of a sick mount rather than one broken release.
 * Every block is temporary; a successful read clears the file and its root, so
 * recovery needs no operator action.
 */
export class StorageHealthService {
	readonly serviceName = "StorageHealthService";
	readonly logger = createLogger("StorageHealthService");

	private readonly files = new Map<string, FileHealth>();
	private readonly roots = new Map<string, RootHealth>();
	private readonly now: () => number;
	private readonly mounts: () => string[];
	private lastExpirySweepAt = 0;

	constructor(dependencies: StorageHealthDependencies = {}) {
		this.now = dependencies.now ?? Date.now;
		this.mounts = dependencies.mounts ?? defaultMounts;
	}

	getRootForPath(path: string): string {
		return resolveStorageRoot(path, this.mounts());
	}

	/** Whether this file must not be read by background work right now. */
	isFileBlocked(path: string): boolean {
		const now = this.now();
		const root = this.roots.get(this.getRootForPath(path));
		if (root && root.degradedUntil > now) return true;

		const file = this.files.get(path);

		return file !== undefined && file.blockedUntil > now;
	}

	isRootDegraded(path: string): boolean {
		const root = this.roots.get(this.getRootForPath(path));

		return root !== undefined && root.degradedUntil > this.now();
	}

	recordFailure(path: string, reason: StorageFailureReason): void {
		const now = this.now();
		const rootPath = this.getRootForPath(path);
		this.recordFileFailure(path, reason, now);
		this.recordRootFailure(rootPath, path, reason, now);
		this.enforceCaps();
		if (now - this.lastExpirySweepAt >= EXPIRY_SWEEP_MS) {
			this.lastExpirySweepAt = now;
			this.sweepExpired(now);
		}
	}

	/** A successful read proves the storage answers again; clear the file and its root. */
	recordSuccess(path: string): void {
		const now = this.now();
		const rootPath = this.getRootForPath(path);
		const file = this.files.get(path);
		const root = this.roots.get(rootPath);

		this.files.delete(path);

		if (root) {
			const wasDegraded = root.degradedUntil > now;
			this.roots.delete(rootPath);

			if (wasDegraded) this.logger.info("Storage recovered after a successful read", { root: rootPath, file: path });
		}

		if (file && file.blockedUntil > now) this.logger.info("Blocked media file is readable again", { file: path });
	}

	getSnapshot(): StorageHealthSnapshot {
		const now = this.now();
		const degradedRoots: DegradedStorageRoot[] = [];
		const blockedFiles: BlockedStorageFile[] = [];

		for (const [root, health] of this.roots) {
			if (health.degradedUntil <= now) continue;

			degradedRoots.push({
				root,
				failures: health.failures,
				distinctFiles: health.files.size,
				reason: health.reason,
				remainingMs: health.degradedUntil - now,
			});
		}

		for (const [path, health] of this.files) {
			if (health.blockedUntil <= now) continue;

			blockedFiles.push({
				path,
				failures: health.failures,
				reason: health.reason,
				remainingMs: health.blockedUntil - now,
			});
		}

		return { degradedRoots, blockedFiles };
	}

	reset(): void {
		this.files.clear();
		this.roots.clear();
		this.lastExpirySweepAt = 0;
	}

	private recordFileFailure(path: string, reason: StorageFailureReason, now: number): void {
		const previous = this.files.get(path);
		const { failures, firstFailureAt } = countFailure(previous, now);
		const alreadyBlocked = previous !== undefined && previous.blockedUntil > now;
		const blockedUntil = failures >= 2 ? now + FILE_BLOCK_MS : (previous?.blockedUntil ?? 0);

		this.files.delete(path);
		this.files.set(path, { failures, firstFailureAt, lastFailureAt: now, blockedUntil, reason });

		if (!alreadyBlocked && blockedUntil > now) {
			this.logger.warn("Media file blocked after repeated read failures", {
				file: path,
				failures,
				reason,
				blockedForMs: FILE_BLOCK_MS,
			});
		}
	}

	private recordRootFailure(root: string, path: string, reason: StorageFailureReason, now: number): void {
		const previous = this.roots.get(root);
		const { recentlyFailed, failures, firstFailureAt } = countFailure(previous, now);
		const files = recentlyFailed && previous !== undefined ? previous.files : new Set<string>();
		if (files.size < MAX_ROOT_FAILURE_FILES) files.add(path);

		const shouldDegrade =
			failures >= ROOT_FAILURE_THRESHOLD && files.size >= ROOT_DISTINCT_FILE_THRESHOLD && (previous?.degradedUntil ?? 0) <= now;
		const degradedUntil = shouldDegrade ? now + ROOT_DEGRADED_MS : (previous?.degradedUntil ?? 0);

		this.roots.delete(root);
		this.roots.set(root, { failures, firstFailureAt, lastFailureAt: now, degradedUntil, reason, files });

		if (shouldDegrade) {
			this.logger.warn("Storage root marked degraded; background reads on it are skipped", {
				root,
				failures,
				distinctFiles: files.size,
				reason,
				degradedForMs: ROOT_DEGRADED_MS,
			});
		}
	}

	private sweepExpired(now: number): void {
		for (const [path, health] of this.files) {
			const expired = health.blockedUntil <= now && now - health.lastFailureAt > FAILURE_WINDOW_MS;
			if (expired) this.files.delete(path);
		}

		for (const [root, health] of this.roots) {
			const expired = health.degradedUntil <= now && now - health.lastFailureAt > FAILURE_WINDOW_MS;
			if (expired) this.roots.delete(root);
		}
	}

	private enforceCaps(): void {
		while (this.files.size > MAX_TRACKED_FILES) {
			const oldest = this.files.keys().next().value;
			if (oldest === undefined) break;

			this.files.delete(oldest);
		}

		while (this.roots.size > MAX_TRACKED_ROOTS) {
			const oldest = this.roots.keys().next().value;
			if (oldest === undefined) break;

			this.roots.delete(oldest);
		}
	}
}

export const storageHealthService = new StorageHealthService();
