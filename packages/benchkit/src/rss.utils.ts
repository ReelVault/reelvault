import { readFileSync } from "node:fs";

const VM_RSS_PATTERN = /VmRSS:\s+(\d+)\s+kB/;
/** Fields after the parenthesized comm in /proc stat are whitespace-separated. */
const STAT_FIELDS_PATTERN = /\s+/;
/** Linux reports /proc stat times in USER_HZ ticks; USER_HZ is always 100 on Linux. */
const USER_HZ = 100;

export interface RssSummary {
	startBytes?: number;
	peakBytes?: number;
	endBytes?: number;
}

/**
 * Reads a process's resident set size from /proc. Linux-only: returns
 * undefined on other platforms or once the process is gone.
 */
export function readProcessRssBytes(pid: number): number | undefined {
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf-8");
		const match = VM_RSS_PATTERN.exec(status);

		return match ? Number(match[1]) * 1024 : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Samples a process's RSS every `intervalMs` until stopped. The returned
 * stop() captures one final sample and reports the summary. The timer is
 * unref'd so it never keeps the benchmark process alive.
 */
export function startRssSampler(pid: number, intervalMs: number, onSummary: (summary: RssSummary) => void): () => void {
	const summary: RssSummary = {};
	const capture = (rss: number): void => {
		summary.startBytes ??= rss;
		summary.peakBytes = Math.max(summary.peakBytes ?? 0, rss);
		summary.endBytes = rss;
	};
	const timer = setInterval(() => {
		const rss = readProcessRssBytes(pid);
		if (rss !== undefined) capture(rss);
	}, intervalMs);
	timer.unref();

	return () => {
		clearInterval(timer);
		const rss = readProcessRssBytes(pid);
		if (rss !== undefined) capture(rss);

		onSummary(summary);
	};
}

export interface CpuSummary {
	/** Consumed CPU milliseconds at the first sample. */
	startMs?: number;
	/** Consumed CPU milliseconds at the last sample. */
	endMs?: number;
	/** CPU milliseconds consumed between the first and the last sample. */
	deltaMs?: number;
}

/** Reads the process's consumed CPU time (user + system) in ms from /proc. Linux-only. */
function readProcessCpuMs(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		const close = stat.lastIndexOf(")");
		if (close === -1) return undefined;

		// Fields after the parenthesized comm: state is field 3, utime field 14, stime field 15.
		const fields = stat
			.slice(close + 1)
			.trim()
			.split(STAT_FIELDS_PATTERN);
		const utime = Number(fields[11]);
		const stime = Number(fields[12]);
		if (!(Number.isFinite(utime) && Number.isFinite(stime))) return undefined;

		return ((utime + stime) / USER_HZ) * 1000;
	} catch {
		return undefined;
	}
}

/**
 * Samples a process's consumed CPU time every `intervalMs` until stopped. The
 * first sample is taken immediately, so `deltaMs` covers the whole window; the
 * returned stop() captures one final sample and reports the summary. The timer
 * is unref'd so it never keeps the benchmark process alive.
 */
export function startCpuSampler(pid: number, intervalMs: number, onSummary: (summary: CpuSummary) => void): () => void {
	const summary: CpuSummary = {};
	const capture = (ms: number): void => {
		summary.startMs ??= ms;
		summary.endMs = ms;
		summary.deltaMs = summary.endMs - summary.startMs;
	};

	const initial = readProcessCpuMs(pid);
	if (initial !== undefined) capture(initial);

	const timer = setInterval(() => {
		const ms = readProcessCpuMs(pid);
		if (ms !== undefined) capture(ms);
	}, intervalMs);
	timer.unref();

	return () => {
		clearInterval(timer);
		const ms = readProcessCpuMs(pid);
		if (ms !== undefined) capture(ms);

		onSummary(summary);
	};
}

export interface ProcessSample {
	rss: RssSummary;
	cpu: CpuSummary;
}

/**
 * Samples a process's RSS and CPU time together over one measured window; the returned stop()
 * ends both samplers and returns what they saw. Linux-only, like the readers it uses.
 */
export function startProcessSampler(pid: number, intervalMs: number): () => ProcessSample {
	const sample: ProcessSample = { rss: {}, cpu: {} };
	const stopRss = startRssSampler(pid, intervalMs, (rss) => {
		sample.rss = rss;
	});
	const stopCpu = startCpuSampler(pid, intervalMs, (cpu) => {
		sample.cpu = cpu;
	});

	return () => {
		stopRss();
		stopCpu();

		return sample;
	};
}
