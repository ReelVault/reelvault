import { statfs } from "node:fs/promises";
import { freemem, loadavg, totalmem } from "node:os";
import { file as bunFile } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { clamp } from "@/utils/math.utils";
import { getAvailableMemoryKiB, getTotalMemoryKiB, readCgroupMemoryLimitKiB, readCgroupMemoryUsageKiB } from "@/utils/mem.utils";
import { isFiniteNumber } from "@/utils/type.utils";
import type { ResourceMetrics, ResourceSnapshot } from "./resource-allocator.types";

type MemoryReading = ResourceSnapshot["memory"];
type DiskReading = ResourceSnapshot["disk"];

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}
function percentOf(used: number, total: number): number {
	return total > 0 ? round1((used / total) * 100) : 0;
}

export function memoryReading(totalMb: number, usedMb: number): MemoryReading {
	// A memory limit can be lower than the host's available figure (cgroup quota,
	// benchmark simulation). Never report negative use or a percentage above 100:
	// the dashboard schema rejects both and turns the whole page into a 500.
	const total = Math.max(0, totalMb);
	const used = clamp(usedMb, 0, total);

	return { usedMb: used, totalMb: total, percent: percentOf(used, total) };
}

/** Container memory when a cgroup limit is set, otherwise the host's `/proc/meminfo`, otherwise `os` totals. */
export function getMemoryInfo(): MemoryReading {
	const cgroupLimitKiB = readCgroupMemoryLimitKiB();
	const cgroupUsageKiB = readCgroupMemoryUsageKiB();

	if (cgroupLimitKiB !== undefined) {
		const totalMb = Math.round(cgroupLimitKiB / 1024);
		if (totalMb > 0) return memoryReading(totalMb, Math.round((cgroupUsageKiB ?? 0) / 1024));
	}

	// Reuse the shared /proc/meminfo readers instead of re-parsing the file here.
	const totalKiB = getTotalMemoryKiB();
	const availableKiB = getAvailableMemoryKiB();
	if (totalKiB !== undefined && totalKiB > 0 && availableKiB !== undefined && availableKiB > 0) {
		// A simulated/limited total can be below the host's MemAvailable. Report
		// this process's RSS instead of a negative figure (or a meaningless zero).
		const usedKiB = availableKiB >= totalKiB ? Math.round(process.memoryUsage().rss / 1024) : totalKiB - availableKiB;

		return memoryReading(Math.round(totalKiB / 1024), Math.round(usedKiB / 1024));
	}

	const totalMb = Math.round(totalmem() / 1024 / 1024);
	const freeMb = Math.round(freemem() / 1024 / 1024);

	return memoryReading(totalMb, totalMb - freeMb);
}

async function getDiskInfo(path: string): Promise<DiskReading> {
	try {
		const stat = await statfs(path);
		const totalBytes = stat.blocks * stat.bsize;
		const freeBytes = stat.bavail * stat.bsize;
		const usedBytes = totalBytes - freeBytes;
		const totalGb = round1(totalBytes / 1024 / 1024 / 1024);
		const usedGb = round1(usedBytes / 1024 / 1024 / 1024);

		return { usedGb, totalGb, percent: percentOf(usedGb, totalGb) };
	} catch {
		return { usedGb: 0, totalGb: 0, percent: 0 };
	}
}

// CPU sampling state — we compare the current /proc/stat against the previous
// reading taken on the last monitoring interval. Two back-to-back reads in the
// same microsecond always produce delta≈0 (always 0% CPU), which is wrong.
let previousCpuTotal = 0;
let previousCpuIdle = 0;

// cgroup CPU accounting (v2 `cpu.stat` usage_usec / v1 cpuacct.usage). In a
// container /proc/stat reports the HOST, so a busy host makes the container look
// pegged; cgroup usage divided by the effective core quota is container-accurate.
const CGROUP_V2_CPU_STAT_PATH = "/sys/fs/cgroup/cpu.stat";
const CGROUP_V1_CPUACCT_PATH = "/sys/fs/cgroup/cpuacct/cpuacct.usage";
const CPU_USAGE_USEC_REGEX = /usage_usec\s+(\d+)/;
/** Last cgroup reading. The first reading only sets it, so the next one can compute a delta. */
let cgroupBaseline: { usageMicros: number; sampledAt: number } | undefined;

// The cgroup hierarchy never changes at runtime — remember which source works
// instead of re-probing v2 and v1 (throwing) on every snapshot.
type CgroupCpuSource = "v2" | "v1" | "none";
let cgroupCpuSource: CgroupCpuSource | undefined;

async function readCgroupCpuUsageMicros(): Promise<number | undefined> {
	if (cgroupCpuSource === "none") return undefined;

	if (cgroupCpuSource === undefined || cgroupCpuSource === "v2") {
		try {
			const stat = await bunFile(CGROUP_V2_CPU_STAT_PATH).text();
			const match = CPU_USAGE_USEC_REGEX.exec(stat);
			if (match?.[1]) {
				cgroupCpuSource = "v2";

				return Number.parseInt(match[1], 10);
			}
		} catch {
			// Cgroup v2 cpu.stat unreadable — fall back to v1.
		}

		if (cgroupCpuSource === "v2") return undefined;
	}

	try {
		const nanos = Number.parseInt((await bunFile(CGROUP_V1_CPUACCT_PATH).text()).trim(), 10);
		if (isFiniteNumber(nanos)) {
			cgroupCpuSource = "v1";

			return nanos / 1000;
		}
	} catch {
		// Cgroup v1 cpuacct unreadable — report usage as unavailable.
	}

	cgroupCpuSource = "none";

	return undefined;
}

/** Container CPU percent between two cgroup readings; null on the first reading, which only sets the baseline. */
export function cgroupCpuPercent(usageMicros: number, now: number, effectiveCores: number) {
	const previous = cgroupBaseline;
	cgroupBaseline = { usageMicros, sampledAt: now };
	if (!previous) return null;

	const usageDeltaMicros = usageMicros - previous.usageMicros;
	const timeDeltaMicros = (now - previous.sampledAt) * 1000;
	if (timeDeltaMicros <= 0 || usageDeltaMicros < 0 || effectiveCores <= 0) return 0;

	const coresUsed = usageDeltaMicros / timeDeltaMicros;

	return round1(clamp((coresUsed / effectiveCores) * 100, 0, 100));
}

/** Container CPU percent since the previous sample, or null when cgroup usage is unreadable. */
async function sampleCgroupCpuPercent() {
	const usageMicros = await readCgroupCpuUsageMicros();
	if (usageMicros === undefined) return null;

	return cgroupCpuPercent(usageMicros, Date.now(), systemResourcesService.getMetrics().effectiveCores);
}

/** The total and idle jiffies of the `/proc/stat` aggregate CPU line. */
function parseProcStatCpuLine(cpuLine: string): { total: number; idle: number } {
	let total = 0;
	let idle = 0;
	let fieldIndex = 0;
	let start = 0;

	for (let i = 0; i <= cpuLine.length; i++) {
		if (i === cpuLine.length || cpuLine.charCodeAt(i) === 32) {
			if (i > start) {
				const value = Number(cpuLine.slice(start, i));
				total += value;
				if (fieldIndex === 3 || fieldIndex === 4) idle += value;

				fieldIndex++;
			}

			start = i + 1;
		}
	}

	return { total, idle };
}

/** Host CPU percent since the previous sample, from the `/proc/stat` aggregate line. */
async function sampleProcStatCpuPercent(): Promise<number> {
	try {
		const text = await bunFile("/proc/stat").text();
		const lineEnd = text.indexOf("\n");
		const cpuLine = lineEnd === -1 ? text.slice(text.indexOf(" ") + 1) : text.slice(text.indexOf(" ") + 1, lineEnd);

		const { total, idle } = parseProcStatCpuLine(cpuLine);
		const totalDelta = total - previousCpuTotal;
		const idleDelta = idle - previousCpuIdle;

		previousCpuTotal = total;
		previousCpuIdle = idle;

		if (totalDelta <= 0) return 0;

		return percentOf(totalDelta - idleDelta, totalDelta);
	} catch {
		return 0;
	}
}

async function getCpuUsage(): Promise<number> {
	// Prefer container-aware accounting; fall back to host /proc/stat when the
	// process is not under a readable cgroup hierarchy.
	return (await sampleCgroupCpuPercent()) ?? (await sampleProcStatCpuPercent());
}

export async function readHostMetrics(): Promise<ResourceMetrics> {
	const [cpuUsedPercent, disk] = await Promise.all([getCpuUsage(), getDiskInfo(serverConfig.paths.transcodes)]);

	return { cpuUsedPercent, memory: getMemoryInfo(), disk };
}

export function readLoadAverage(): [number, number, number] {
	const [load1 = 0, load5 = 0, load15 = 0] = loadavg();

	return [load1, load5, load15];
}
