import { readFileSync } from "node:fs";
import { gc } from "bun";
import { env } from "@/config/env.config";
import { detectHostTotalMemoryKiB } from "@/config/system-resources/hardware.utils";
import { KIB } from "@/utils/bytes.utils";
import { isFiniteNumber } from "./type.utils";

const MEMINFO_REGEX = {
	MemTotal: /MemTotal:\s+(\d+)/,
	MemAvailable: /MemAvailable:\s+(\d+)/,
} as const;
const V1_UNLIMITED_BYTES = 0x7fff_ffff_0000_0000;
/** ZFS exposes its ARC counters as a Linux kstat file: `name type data`, one counter per line. */
const ZFS_ARCSTATS_PATH = "/proc/spl/kstat/zfs/arcstats";
const ZFS_ARCSTAT_LINE_REGEX = /^(size|c_min)\s+\d+\s+(\d+)$/;

let cachedTotalKiB: number | undefined;
/** Host facts are stable, but a container's quota can change (docker update / VPA): refresh periodically. */
const MEMORY_CACHE_TTL_MS = 5 * 60_000;
let cachedTotalAt = 0;

export function isMemoryCacheEntryFresh(resolvedAt: number, now: number): boolean {
	return resolvedAt > 0 && now >= resolvedAt && now - resolvedAt < MEMORY_CACHE_TTL_MS;
}

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

/** The `MemTotal` or `MemAvailable` line from `/proc/meminfo`, in KiB. */
export function parseMeminfoKiB(meminfo: string, field: keyof typeof MEMINFO_REGEX): number | undefined {
	const parsed = Number.parseInt(MEMINFO_REGEX[field].exec(meminfo)?.[1] ?? "0", 10);

	return parsed > 0 ? parsed : undefined;
}

/** A cgroup memory limit (`max` or the v1 unlimited sentinel means no limit), in KiB. */
export function parseCgroupLimitKiB(raw: string, hierarchy: Exclude<CgroupHierarchy, "none">): number | undefined {
	const bytes = Number(raw.trim());
	const unlimited = hierarchy === "v1" && bytes >= V1_UNLIMITED_BYTES;

	return isFiniteNumber(bytes) && bytes > 0 && !unlimited ? Math.floor(bytes / KIB) : undefined;
}

/** A cgroup memory usage counter, in KiB. */
export function parseCgroupUsageKiB(raw: string): number | undefined {
	const bytes = Number(raw.trim());

	return isFiniteNumber(bytes) && bytes >= 0 ? Math.floor(bytes / KIB) : undefined;
}

/** Uses the container quota when it is stricter than the host reading. */
export function capTotalMemoryKiB(total: number | undefined, cgroupLimit: number | undefined): number | undefined {
	if (cgroupLimit === undefined) return total;

	return total === undefined ? cgroupLimit : Math.min(total, cgroupLimit);
}

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

type CgroupFileReader = (path: string) => string;

const readCgroupFile: CgroupFileReader = (path) => readFileSync(path, "utf8");

let cachedLimitKiB: number | undefined;
let cachedLimitAt = 0;

/**
 * The container memory limit in KiB, or undefined when the current read reports none.
 * The quota can change while the server runs (docker update, VPA), so each read is
 * kept for MEMORY_CACHE_TTL_MS and then probed again. The hierarchy and file reader
 * default to the host; tests pass fixtures.
 */
export function readCgroupMemoryLimitKiB(
	now: number = Date.now(),
	hierarchy: CgroupHierarchy = resolveCgroupHierarchy(),
	readFile: CgroupFileReader = readCgroupFile,
): number | undefined {
	if (isMemoryCacheEntryFresh(cachedLimitAt, now)) return cachedLimitKiB;

	cachedLimitAt = now;
	cachedLimitKiB = hierarchy === "none" ? undefined : readLimitKiB(hierarchy, readFile);

	return cachedLimitKiB;
}

function readLimitKiB(hierarchy: Exclude<CgroupHierarchy, "none">, readFile: CgroupFileReader): number | undefined {
	const paths = hierarchy === "v2" ? [CGROUP_V2_LIMIT_PATH] : CGROUP_V1_LIMIT_PATHS;
	for (const path of paths) {
		try {
			const limit = parseCgroupLimitKiB(readFile(path), hierarchy);
			if (limit !== undefined) return limit;

			if (hierarchy === "v2") return undefined; // v2 "max" (unlimited) — no other path to try
		} catch {
			// Limit unreadable — fall through to the next candidate path.
		}
	}

	return undefined;
}

export function readCgroupMemoryUsageKiB(): number | undefined {
	const hierarchy = resolveCgroupHierarchy();
	if (hierarchy === "none") return undefined;

	const paths = hierarchy === "v2" ? [CGROUP_V2_USAGE_PATH] : CGROUP_V1_USAGE_PATHS;
	for (const path of paths) {
		try {
			const usage = parseCgroupUsageKiB(readFileSync(path, "utf8"));
			if (usage !== undefined) return usage;
		} catch {
			// Usage unreadable — fall through to the next candidate path.
		}
	}

	return undefined;
}

export function getTotalMemoryKiB(now: number = Date.now()): number | undefined {
	const simulated = env.REELVAULT_BENCH_TOTAL_MEMORY_KIB;
	if (simulated !== undefined) return simulated;

	if (!isMemoryCacheEntryFresh(cachedTotalAt, now)) {
		cachedTotalAt = now;
		let total: number | undefined;
		try {
			total = parseMeminfoKiB(readFileSync("/proc/meminfo", "utf8"), "MemTotal");
		} catch {
			// Unreadable — fall back below.
		}

		// /proc/meminfo is absent on some hosts (containers, non-Linux). The
		// host reading that system-resources owns is the fallback.
		total ??= detectHostTotalMemoryKiB();
		cachedTotalKiB = capTotalMemoryKiB(total, readCgroupMemoryLimitKiB(now));
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
		return parseMeminfoKiB(readFileSync("/proc/meminfo", "utf8"), "MemAvailable");
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
	private readonly collect: () => void;

	constructor(interval = 25, collect: () => void = () => setTimeout(() => gc(false), 0).unref()) {
		this.interval = interval;
		this.collect = collect;
	}

	tick(): void {
		if (++this.count >= this.interval) {
			this.count = 0;
			// Defer GC off the synchronous processing path to avoid Stop-The-World
			// pauses on the event loop. Same pattern as worker-execution-pool.ts.
			this.collect();
		}
	}
}
