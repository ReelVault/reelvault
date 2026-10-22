import type { LatencyStats } from "./latency.utils";

/** Prints an ASCII table. Rows are pre-formatted strings aligned to `columns`. */
export function printTable(title: string, columns: readonly string[], rows: ReadonlyArray<readonly string[]>): void {
	const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => row[index]?.length ?? 0)));
	const separator = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
	const formatRow = (row: readonly string[]) => `| ${row.map((cell, index) => cell.padStart(widths[index] ?? 0)).join(" | ")} |`;

	console.log(`\n${title}`);
	console.log(separator);
	console.log(formatRow(columns));
	console.log(separator);
	for (const row of rows) console.log(formatRow(row));

	console.log(separator);
}

export const fmtMs = (value: number): string => `${value.toFixed(2)}ms`;

export const fmtMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/** Byte throughput in MB/s; zero for an empty window. */
export function mbPerSecond(bytes: number, elapsedMs: number): number {
	return elapsedMs > 0 ? bytes / (elapsedMs / 1000) / 1024 / 1024 : 0;
}

/** The p50/p95/p99/max cells every latency table shares. */
export function latencyCells(stats: LatencyStats): [string, string, string, string] {
	return [fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.p99Ms), fmtMs(stats.maxMs)];
}
