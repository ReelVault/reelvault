import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtMs, main, printTable, suiteArgs, summarizeLatencies, task } from "benchkit";
import { sleep } from "bun";
import { LibraryWatcherService } from "@/application/libraries/watching/library-watcher.service";
import { systemSettingsStore } from "@/config/system-settings.store";
import { librariesRepository } from "@/database/repositories/libraries.repository";

/**
 * Library watcher suite. Zero coverage before this existed: fs.watch feeds a
 * debounced state machine that fires a scan; the debounce floor is the
 * `scanning.autoWatcherDelaySeconds` setting (min 2s).
 *
 * Measures, against a real fs.watch on a tmpdir:
 *  1. single event → scan-callback latency,
 *  2. a 50-file burst — events coalesce into few scans; counts callbacks so
 *     the debounce behavior stays visible, not just the latency.
 */

interface ScanCall {
	libraryId: string;
	pathId: string;
	at: number;
}

async function waitForScan(scans: ScanCall[], startedAt: number, timeoutMs: number): Promise<ScanCall | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const scan = scans.find((call) => call.at >= startedAt);
		if (scan) return scan;

		await sleep(10);
	}

	return undefined;
}

export const meta = { description: "Library watcher (fs event → debounced scan latency, burst coalescing)" };

const args = suiteArgs();

if (!args.help) {
	task("watcher: events", async () => {
		const root = mkdtempSync(join(tmpdir(), "reelvault-benchmark-watcher-"));
		const service = new LibraryWatcherService();
		const scans: ScanCall[] = [];
		try {
			// Same seams the unit tests use: runtime settings + repository monkey-patch,
			// so the watcher watches a throwaway tmpdir without a database.
			systemSettingsStore.setRuntimeValue("scanning.autoWatcherEnabled", true);
			systemSettingsStore.setRuntimeValue("scanning.autoWatcherDelaySeconds", 2);
			systemSettingsStore.setRuntimeValue("scanning.autoWatcherCooldownSeconds", 2);
			// Overwritten for the lifetime of this short-lived benchmark process —
			// no restore needed (unit tests restore because they share a process).
			librariesRepository.findActiveLibraryPaths = () =>
				Promise.resolve([{ id: "path-bench", libraryId: "lib-bench", path: root, isActive: true }]);

			service.registerScanner((libraryId, pathId) => {
				scans.push({ libraryId, pathId, at: Date.now() });

				return Promise.resolve();
			});
			await service.init();

			// ─── 1. Single-event latency ───
			const singleLatencies: number[] = [];
			const singleRounds = Math.max(3, Math.min(10, Math.floor(args.durationMs / 2500)));
			for (let round = 0; round < singleRounds; round++) {
				const file = join(root, `single-${round}.txt`);
				const startedAt = Date.now();
				writeFileSync(file, "benchmark");
				const scan = await waitForScan(scans, startedAt, 10_000);
				if (scan) singleLatencies.push(scan.at - startedAt);

				// Space rounds beyond the cooldown so each fires its own scan.
				await sleep(2200);
			}

			const singleStats = summarizeLatencies(singleLatencies.length > 0 ? singleLatencies : [0]);
			printTable(
				"Single fs event → scan callback",
				["rounds", "latency p50", "max", "callbacks"],
				[[String(singleRounds), fmtMs(singleStats.p50Ms), fmtMs(singleStats.maxMs), String(scans.length)]],
			);

			// ─── 2. Burst coalescing ───
			const scansBeforeBurst = scans.length;
			const burstSize = 50;
			const burstStartedAt = Date.now();
			for (let index = 0; index < burstSize; index++) {
				writeFileSync(join(root, `burst-${index}.txt`), "benchmark");
			}

			// The debounce delay is 2s; wait past it plus margin for the fired scan.
			await sleep(3500);
			const burstCallbacks = scans.length - scansBeforeBurst;
			const firstBurstScan = scans.find((call) => call.at >= burstStartedAt);
			const burstLatency = firstBurstScan ? firstBurstScan.at - burstStartedAt : -1;

			printTable(
				`Burst (${burstSize} files written back-to-back)`,
				["scan callbacks fired", "first callback after", "coalescing"],
				[
					[
						String(burstCallbacks),
						burstLatency >= 0 ? fmtMs(burstLatency) : "timeout",
						burstCallbacks === 1 ? "1 scan for whole burst" : `${burstCallbacks} scans`,
					],
				],
			);
		} finally {
			service.stopAllWatchers();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

await main(import.meta);
