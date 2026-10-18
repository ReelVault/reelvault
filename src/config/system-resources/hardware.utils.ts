import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import type { Logger } from "@reelvault/sdk/common";
import { isFiniteNumber, isNonEmptyString } from "@/utils/type.utils";

const WHITESPACE_REGEX = /\s+/;

export function parseCgroupQuotaCores(quotaStr: string, periodStr: string): number | undefined {
	const quota = Number.parseInt(quotaStr, 10);
	const period = Number.parseInt(periodStr, 10);
	if (!(quota > 0 && period > 0)) return undefined;

	return Math.max(1, Math.floor(quota / period));
}

/** Counts CPUs listed in a cpuset string like "0-3,7,9-10". */
export function parseCpusetCores(raw: string): number | undefined {
	if (!isNonEmptyString(raw)) return undefined;

	const trimmed = raw.trim();

	let count = 0;
	for (const part of trimmed.split(",")) {
		const [startStr, endStr] = part.split("-");
		if (!startStr) continue;

		const start = Number.parseInt(startStr, 10);
		const end = endStr ? Number.parseInt(endStr, 10) : start;

		if (isFiniteNumber(start) && isFiniteNumber(end) && end >= start) {
			count += end - start + 1;
		}
	}

	return count > 0 ? count : undefined;
}

function readCgroupQuotaCores(logger: Logger): number | undefined {
	try {
		const [quotaStr, periodStr] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(WHITESPACE_REGEX);
		if (quotaStr && quotaStr !== "max" && periodStr) {
			return parseCgroupQuotaCores(quotaStr, periodStr);
		}

		return undefined;
	} catch {
		try {
			const quotaStr = readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").trim();
			const periodStr = readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").trim();
			const quotaCores = parseCgroupQuotaCores(quotaStr, periodStr);
			if (quotaCores !== undefined) logger.debug("Read cgroup v1 CPU quota", { quotaCores });

			return quotaCores;
		} catch {
			return undefined;
		}
	}
}

function readCpusetCores(logger: Logger): number | undefined {
	for (const path of ["/sys/fs/cgroup/cpuset.cpus.effective", "/sys/fs/cgroup/cpuset/cpuset.cpus"]) {
		try {
			const raw = readFileSync(path, "utf8");
			const cores = parseCpusetCores(raw);
			if (cores !== undefined) {
				logger.debug("Read cpuset CPU limit", { path, cores });

				return cores;
			}
		} catch {
			// try next path
		}
	}

	return undefined;
}

/**
 * Cores this process may use: the OS count, capped by the cgroup CPU quota and
 * the cpuset (Proxmox LXC, Docker and Kubernetes commonly pin a cpuset).
 */
export function detectHostCores(logger: Logger): number {
	let detected: number;
	try {
		detected = availableParallelism();
	} catch {
		detected = cpus().length;
		logger.debug("availableParallelism failed, falling back to CPU count", { detectedCores: detected });
	}

	const quotaCores = readCgroupQuotaCores(logger);
	if (quotaCores !== undefined) {
		detected = Math.min(detected, quotaCores);
		logger.debug("Applied cgroup CPU quota", { quotaCores, detectedCores: detected });
	}

	const cpusetCores = readCpusetCores(logger);
	if (cpusetCores !== undefined) {
		detected = Math.min(detected, cpusetCores);
		logger.debug("Applied cpuset CPU limit", { cpusetCores, detectedCores: detected });
	}

	return Math.max(1, detected || 1);
}
