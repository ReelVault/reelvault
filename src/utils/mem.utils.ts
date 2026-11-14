import { readFileSync } from "node:fs";
import { gc } from "bun";
import { env } from "@/config/env.config";
import { detectHostTotalMemoryKiB } from "@/config/system-resources/hardware.utils";
import { KIB } from "@/utils/bytes.utils";
import { isFiniteNumber } from "./type.utils";

const MEM_TOTAL_REGEX = /MemTotal:\s+(\d+)/;
const MEM_AVAILABLE_REGEX = /MemAvailable:\s+(\d+)/;
/** ZFS exposes its ARC counters as a Linux kstat file: `name type data`, one counter per line. */
const ZFS_ARCSTATS_PATH = "/proc/spl/kstat/zfs/arcstats";
const ZFS_ARCSTAT_LINE_REGEX = /^(size|c_min)\s+\d+\s+(\d+)$/;

let cachedTotalKiB: number | undefined;
let cached = false;

/**
 * The cgroup hierarchy never changes at runtime — resolve it once, then read
 * only the working paths. Without this, every resource snapshot paid up to six
 * sync reads (several of them throwing) to rediscover the same layout.
 */
type CgroupHierarchy = "v2" | "v1" | "none";

const CGROUP_V2_LIMIT_PATH = "/sys/fs/cgroup/memory.max";
const CGROUP_V2_USAGE_PATH = "/sys/fs/cgroup/memory.current";
const CGROUP_V1_LIMIT_PATHS = ["/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory.limit_in_bytes"] as const;
const CGROUP_V1_USAGE_PATHS = ["/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory.usage_in_bytes"] as const;

let cgroupHierarchy: CgroupHierarchy | undefined;

function resolveCgroupHierarchy(): CgroupHierarchy {
	cgroupHierarchy ??= detectCgroupHierarchy();

	return cgroupHierarchy;
}

function detectCgroupHierarchy(): CgroupHierarchy {
	// Existence probe only — limit validity is decided by the readers.
	for (const path of [CGROUP_V2_LIMIT_PATH, CGROUP_V2_USAGE_PATH]) {
		try {
			readFileSync(path, "utf8");

			return "v2";
		} catch {
			// Path not present on this system — probe the next candidate.
		}
	}

	for (const path of [...CGROUP_V1_LIMIT_PATHS, ...CGROUP_V1_USAGE_PATHS]) {
		try {
			readFileSync(path, "utf8");

			return "v1";
		} catch {
			// Path not present on this system — probe the next candidate.
		}
	}

	return "none";
}

// Container memory quota is fixed at creation — probe once, cache the outcome
// (including "no limit") for the process lifetime.
let cachedLimitKiB: number | undefined;
let limitResolved = false;

export function readCgroupMemoryLimitKiB(): number | undefined {
	if (limitResolved) return cachedLimitKiB;

	limitResolved = true;

	const hierarchy = resolveCgroupHierarchy();
	if (hierarchy === "none") return cachedLimitKiB;

	const paths = hierarchy === "v2" ? [CGROUP_V2_LIMIT_PATH] : CGROUP_V1_LIMIT_PATHS;
	for (const path of paths) {
		try {
			const bytes = Number(readFileSync(path, "utf8").trim());
			// v1 reports ~0x7fff_ffff_0000_0000 when no limit is configured.
			const unlimited = hierarchy === "v1" && bytes >= 0x7fff_ffff_0000_0000;
			if (isFiniteNumber(bytes) && bytes > 0 && !unlimited) {
				cachedLimitKiB = Math.floor(bytes / KIB);

				return cachedLimitKiB;
			}

			if (hierarchy === "v2") break; // v2 "max" (unlimited) — no other path to try
		} catch {
			// Limit unreadable — fall through to the next candidate path.
		}
	}

	return cachedLimitKiB;
}

export function readCgroupMemoryUsageKiB(): number | undefined {
	const hierarchy = resolveCgroupHierarchy();
	if (hierarchy === "none") return undefined;

	const paths = hierarchy === "v2" ? [CGROUP_V2_USAGE_PATH] : CGROUP_V1_USAGE_PATHS;
	for (const path of paths) {
		try {
			const bytes = Number(readFileSync(path, "utf8").trim());
			if (isFiniteNumber(bytes) && bytes >= 0) return Math.floor(bytes / KIB);
		} catch {
			// Usage unreadable — fall through to the next candidate path.
		}
	}

	return undefined;
}

export function getTotalMemoryKiB(): number | undefined {
	const simulated = env.REELVAULT_BENCH_TOTAL_MEMORY_KIB;
	if (simulated !== undefined) return simulated;

	if (!cached) {
		cached = true;
		let total: number | undefined;
		try {
			const meminfo = readFileSync("/proc/meminfo", "utf8");
			const parsed = Number.parseInt(MEM_TOTAL_REGEX.exec(meminfo)?.[1] ?? "0", 10);
			if (parsed > 0) total = parsed;
		} catch {
			// /proc/meminfo unavailable — fall back to os.totalmem().
		}

		// /proc/meminfo unavailable — fall back to the host reading that
		// system-resources owns.
		total ??= detectHostTotalMemoryKiB();

		const cgroupLimit = readCgroupMemoryLimitKiB();
		if (cgroupLimit !== undefined) {
			total = total === undefined ? cgroupLimit : Math.min(total, cgroupLimit);
		}

		cachedTotalKiB = total;
	}

	return cachedTotalKiB;
}

/**
 * Live `MemAvailable` from /proc/meminfo. Deliberately not cached — it changes
 * continuously. Returns undefined when the file is unreadable so callers can
 * fall back to `os.freemem()`.
 */
export function getAvailableMemoryKiB(): number | undefined {
	try {
		const available = Number.parseInt(MEM_AVAILABLE_REGEX.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? "0", 10);

		return available > 0 ? available : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reclaimable ZFS ARC in KiB, or undefined when this host does not run ZFS.
 *
 * The kernel's `MemAvailable` does not know that the ARC can shrink, so a ZFS
 * box reports most of its RAM as used even when the ARC would release it under
 * pressure. The ARC can always be reduced to `c_min`; the difference is the
 * part a memory-hungry workload can actually take back.
 */
export function getZfsArcReclaimableKiB(): number | undefined {
	try {
		return parseZfsArcReclaimableKiB(readFileSync(ZFS_ARCSTATS_PATH, "utf8"));
	} catch {
		return undefined;
	}
}

/** Parses the `arcstats` kstat file; exported so the arithmetic is testable without a ZFS host. */
export function parseZfsArcReclaimableKiB(stats: string): number | undefined {
	let sizeBytes: number | undefined;
	let minBytes: number | undefined;

	for (const line of stats.split("\n")) {
		const match = ZFS_ARCSTAT_LINE_REGEX.exec(line.trim());
		if (!(match?.[1] && match[2])) continue;

		const bytes = Number.parseInt(match[2], 10);
		if (!isFiniteNumber(bytes)) continue;

		if (match[1] === "size") sizeBytes = bytes;
		else minBytes = bytes;
	}

	if (sizeBytes === undefined || minBytes === undefined || sizeBytes <= minBytes) return undefined;

	return Math.floor((sizeBytes - minBytes) / KIB);
}

export class BatchGarbageCollector {
	private count = 0;
	private readonly interval: number;

	constructor(interval = 25) {
		this.interval = interval;
	}

	tick(): void {
		if (++this.count >= this.interval) {
			this.count = 0;
			// Defer GC off the synchronous processing path to avoid Stop-The-World
			// pauses on the event loop. Same pattern as worker-execution-pool.ts.
			setTimeout(() => gc(false), 0).unref();
		}
	}
}
