import { readFileSync } from "node:fs";

const VM_RSS_PATTERN = /VmRSS:\s+(\d+)\s+kB/;

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
		const match = status.match(VM_RSS_PATTERN);

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
