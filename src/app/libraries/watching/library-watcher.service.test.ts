import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { workerOperationRepository } from "@/app/repositories/worker-operation.repository";
import { HOUR } from "@/config/server/server.constants";
import { systemSettingsStore } from "@/config/system-settings.store";
import { serverRescueService } from "@/system/server-rescue.service";
import { removeTreeSync } from "@/utils/directory.utils";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import {
	deleteLibraryPath,
	insertLibraries,
	insertLibraryPaths,
	insertWorkerOperations,
	updateLibraryPathPath,
} from "../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { type LibraryWatcherClock, LibraryWatcherService, type WatcherFailureInfo } from "./library-watcher.service";

const db = useTestDatabase();
const CLOCK_START = Date.parse("2026-01-01T00:00:00.000Z");
const stubs: MethodStub[] = [];

beforeEach(async () => {
	await insertLibraries(db.client(), [
		{ id: "lib-1", name: "Movies", type: "movies" },
		{ id: "lib-2", name: "Shows", type: "tv_shows" },
	]);
});

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	// The settings store is process-global — never leak overrides into other test files.
	systemSettingsStore.clearRuntimeValues();
});

/** Virtual time: timers run in due order; `advance` awaits each callback
 * (fireScan) so the state machine settles deterministically. */
class ManualClock implements LibraryWatcherClock<number> {
	private seq = 0;
	private readonly timers = new Map<number, { at: number; fn: () => unknown }>();
	private currentTime = CLOCK_START;

	now(): number {
		return this.currentTime;
	}

	setTimeout(callback: () => unknown, ms: number): number {
		const id = ++this.seq;
		this.timers.set(id, { at: this.currentTime + Math.max(0, ms), fn: callback });

		return id;
	}

	clearTimeout(timer: number): void {
		this.timers.delete(timer);
	}

	get scheduledCount(): number {
		return this.timers.size;
	}

	async advance(ms: number): Promise<void> {
		const target = this.currentTime + ms;
		for (;;) {
			let nextId: number | undefined;
			let nextAt = Number.POSITIVE_INFINITY;
			for (const [id, timer] of this.timers) {
				if (timer.at <= target && timer.at < nextAt) {
					nextAt = timer.at;
					nextId = id;
				}
			}

			if (nextId === undefined) break;

			this.currentTime = Math.max(this.currentTime, nextAt);
			const timer = this.timers.get(nextId);
			this.timers.delete(nextId);
			await timer?.fn();
		}

		this.currentTime = target;
	}
}

interface ScanCall {
	libraryId: string;
	pathId: string;
}

interface Harness {
	service: LibraryWatcherService;
	clock: ManualClock;
	scanCalls: ScanCall[];
	notifierCalls: WatcherFailureInfo[];
	cleanup(): void;
}

/** State-machine harness: no real fs watchers — events are fed via handleFsEvent. */
function createHarness(options: { cooldownSeconds?: number; rescue?: () => boolean } = {}): Harness {
	const clock = new ManualClock();
	const notifierCalls: WatcherFailureInfo[] = [];
	const service = new LibraryWatcherService(clock, (failure) => {
		notifierCalls.push(failure);

		return Promise.resolve();
	});
	const scanCalls: ScanCall[] = [];
	service.registerScanner((libraryId, pathId) => {
		scanCalls.push({ libraryId, pathId });

		return Promise.resolve({ success: true, operationId: "op-1", status: "pending" });
	});

	if (options.rescue) stubs.push(stubMethod(serverRescueService, "isThrottling", options.rescue));

	systemSettingsStore.setRuntimeValue("scanning.autoWatcherEnabled", true);
	systemSettingsStore.setRuntimeValue("scanning.autoWatcherDelaySeconds", 2);
	systemSettingsStore.setRuntimeValue("scanning.autoWatcherCooldownSeconds", options.cooldownSeconds ?? 0);

	return {
		service,
		clock,
		scanCalls,
		notifierCalls,
		cleanup() {
			service.shutdown();
			systemSettingsStore.clearRuntimeValues();
		},
	};
}

function emitEvent(service: LibraryWatcherService, libraryId = "lib-1", pathId = "path-1"): void {
	service.handleFsEvent(libraryId, pathId, "/media/movies", "change", "video.mp4");
}

async function addLibraryPath(id: string, libraryId: string, path: string): Promise<void> {
	await insertLibraryPaths(db.client(), { id, libraryId, stableKey: id, path });
}

async function recordLibraryScan(libraryId: string, at: number): Promise<void> {
	await insertWorkerOperations(db.client(), {
		type: "library-scanning",
		status: "completed",
		referenceType: "library",
		referenceId: libraryId,
		createdAt: new Date(at),
	});
}

describe("LibraryWatcherService real-time events", () => {
	test("debounces rapid events and fires exactly one scan after the quiet period", async () => {
		const { service, clock, scanCalls, cleanup } = createHarness();
		try {
			emitEvent(service);
			expect(service.getPendingTimerCount()).toBe(1);
			expect(scanCalls.length).toBe(0);

			// Events inside the debounce window re-arm a single timer — no extra timers.
			emitEvent(service);
			emitEvent(service);
			expect(service.getPendingTimerCount()).toBe(1);
			expect(clock.scheduledCount).toBe(1);

			await clock.advance(1999);
			expect(scanCalls.length).toBe(0);

			await clock.advance(1);
			expect(scanCalls.length).toBe(1);
			expect(scanCalls[0]).toEqual({ libraryId: "lib-1", pathId: "path-1" });
			expect(service.getPendingTimerCount()).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("cooldown collapses quiet-gap triggers into one scan per window, with a catch-up scan", async () => {
		const { service, clock, scanCalls, cleanup } = createHarness({ cooldownSeconds: 6 });
		try {
			// First batch → scan fires after the debounce; cooldown now runs 6 s.
			emitEvent(service);
			await clock.advance(2000);
			expect(scanCalls.length).toBe(1);

			// Second batch: debounce fires at t=4000, but the scan is held until
			// the cooldown from t=2000 expires — re-armed, not dropped.
			emitEvent(service);
			await clock.advance(2000);
			expect(scanCalls.length).toBe(1);
			expect(service.getPendingTimerCount()).toBe(1);

			// t=8000: cooldown expired → catch-up scan runs.
			await clock.advance(4000);
			expect(scanCalls.length).toBe(2);
			expect(service.getPendingTimerCount()).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("holds scans while server rescue is throttling and fires on the next re-check after release", async () => {
		let throttling = true;
		const { service, clock, scanCalls, cleanup } = createHarness({ rescue: () => throttling });
		try {
			emitEvent(service);
			await clock.advance(2000);
			// Debounce elapsed but rescue holds the scan (re-armed every 5 s).
			expect(scanCalls.length).toBe(0);
			expect(service.getPendingTimerCount()).toBe(1);

			throttling = false;
			await clock.advance(5000);
			expect(scanCalls.length).toBe(1);
			expect(service.getPendingTimerCount()).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("ignores hidden files, swap files and partial downloads", () => {
		const { service, cleanup } = createHarness();
		try {
			service.handleFsEvent("lib-1", "path-1", "/media/movies", "change", ".DS_Store");
			service.handleFsEvent("lib-1", "path-1", "/media/movies", "change", "video.mp4.tmp");
			service.handleFsEvent("lib-1", "path-1", "/media/movies", "change", "video.mp4.part");
			service.handleFsEvent("lib-1", "path-1", "/media/movies", "change", "archive.crdownload");
			service.handleFsEvent("lib-1", "path-1", "/media/movies", "change", "backup~");
			service.handleFsEvent("lib-1", "path-1", "/media/movies", "change", ".hidden/video.mp4");
			expect(service.getPendingTimerCount()).toBe(0);

			// Real media files schedule a debounce.
			emitEvent(service, "lib-1", "path-2");
			expect(service.getPendingTimerCount()).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("stopWatcher drops pending scans and cooldowns for the path", async () => {
		const { service, clock, scanCalls, cleanup } = createHarness();
		try {
			emitEvent(service, "lib-1", "path-1");
			service.stopWatcher("path-1");
			expect(service.getPendingTimerCount()).toBe(0);

			await clock.advance(5000);
			expect(scanCalls.length).toBe(0);
		} finally {
			cleanup();
		}
	});
});

describe("LibraryWatcherService path failures", () => {
	test("records an unwatchable path and notifies admins once per failure episode", async () => {
		const { service, notifierCalls, cleanup } = createHarness();
		const missingPath = resolve("/non/existent/rv-watcher-test");
		await addLibraryPath("path-gone", "lib-1", missingPath);

		try {
			await service.syncWatchers();

			expect(service.getUnwatchablePaths()).toMatchObject([
				{ libraryId: "lib-1", pathId: "path-gone", path: missingPath, reason: "path_missing" },
			]);
			expect(notifierCalls).toHaveLength(1);
			expect(notifierCalls[0]?.reason).toBe("path_missing");

			// The reconcile tick retries the same failing path without re-notifying.
			await service.syncWatchers();
			expect(notifierCalls).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	test("clears the failure once the path becomes watchable again and cancels its fallback schedule", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "rv-test-watcher-recovery-"));
		const { service, clock, scanCalls, cleanup } = createHarness();
		systemSettingsStore.setRuntimeValue("scanning.watcherFallbackIntervalMinutes", 10);
		await addLibraryPath("path-1", "lib-1", "/non/existent/rv-recovery");

		try {
			await service.syncWatchers();
			expect(service.getUnwatchablePaths()).toHaveLength(1);
			expect(clock.scheduledCount).toBe(1);

			await updateLibraryPathPath(db.client(), "path-1", tempDir);
			await service.syncWatchers();

			expect(service.getUnwatchablePaths()).toEqual([]);
			expect(service.getActiveWatcherCount()).toBe(1);
			// Recovery cancels the fallback schedule.
			expect(clock.scheduledCount).toBe(0);

			await clock.advance(60 * 60_000);
			expect(scanCalls).toEqual([]);
		} finally {
			removeTreeSync(tempDir);
			cleanup();
		}
	});

	test("drops the failure when the path is removed from the library", async () => {
		const { service, cleanup } = createHarness();
		await addLibraryPath("path-gone", "lib-1", "/non/existent/rv-watcher-removed");

		try {
			await service.syncWatchers();
			expect(service.getUnwatchablePaths()).toHaveLength(1);

			await deleteLibraryPath(db.client(), "path-gone");
			await service.syncWatchers();

			expect(service.getUnwatchablePaths()).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("LibraryWatcherService fallback scans", () => {
	test("periodically rescans a path without a real-time watcher", async () => {
		const { service, clock, scanCalls, cleanup } = createHarness();
		systemSettingsStore.setRuntimeValue("scanning.watcherFallbackIntervalMinutes", 10);
		await addLibraryPath("path-gone", "lib-1", "/non/existent/rv-fallback");

		try {
			await service.syncWatchers();
			expect(scanCalls).toEqual([]);

			await clock.advance(10 * 60_000);
			expect(scanCalls).toEqual([{ libraryId: "lib-1", pathId: "path-gone" }]);

			// The schedule re-arms after every fallback scan.
			await clock.advance(10 * 60_000);
			expect(scanCalls).toHaveLength(2);
		} finally {
			cleanup();
		}
	});

	test("fallback scans wait out server rescue throttling", async () => {
		let throttling = true;
		const { service, clock, scanCalls, cleanup } = createHarness({ rescue: () => throttling });
		systemSettingsStore.setRuntimeValue("scanning.watcherFallbackIntervalMinutes", 10);
		await addLibraryPath("path-gone", "lib-1", "/non/existent/rv-fallback-rescue");

		try {
			await service.syncWatchers();

			await clock.advance(10 * 60_000);
			expect(scanCalls).toEqual([]);

			throttling = false;
			await clock.advance(5_000);
			expect(scanCalls).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	test("shutdown cancels the fallback schedule", async () => {
		const { service, clock, scanCalls, cleanup } = createHarness();
		systemSettingsStore.setRuntimeValue("scanning.watcherFallbackIntervalMinutes", 10);
		await addLibraryPath("path-gone", "lib-1", "/non/existent/rv-fallback-shutdown");

		try {
			await service.syncWatchers();
			expect(clock.scheduledCount).toBe(1);

			service.shutdown();
			expect(clock.scheduledCount).toBe(0);

			await clock.advance(60 * 60_000);
			expect(scanCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("LibraryWatcherService periodic library rescan", () => {
	async function seedLibraryPaths(): Promise<void> {
		await addLibraryPath("path-1", "lib-1", "/media/a");
		await addLibraryPath("path-2", "lib-1", "/media/b");
		await addLibraryPath("path-3", "lib-2", "/media/c");
	}

	test("fires one whole-library scan per library when the interval is due, and not while every library was scanned recently", async () => {
		const { service, clock, cleanup } = createHarness();
		await seedLibraryPaths();
		const libraryScanCalls: string[] = [];
		service.registerLibraryScanner((libraryId) => {
			libraryScanCalls.push(libraryId);

			return Promise.resolve();
		});
		systemSettingsStore.setRuntimeValue("scanning.scheduledScanIntervalHours", 1);

		try {
			// No scan operations recorded yet — every library is due.
			await service.runScheduledScanIfDue();
			expect(libraryScanCalls.toSorted()).toEqual(["lib-1", "lib-2"]);

			// A recent scan of every library postpones the next rescan.
			await recordLibraryScan("lib-1", clock.now());
			await recordLibraryScan("lib-2", clock.now());
			libraryScanCalls.length = 0;
			await service.runScheduledScanIfDue();
			expect(libraryScanCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("reschedules only libraries whose last scan is older than the interval", async () => {
		const { service, clock, cleanup } = createHarness();
		await seedLibraryPaths();
		const libraryScanCalls: string[] = [];
		service.registerLibraryScanner((libraryId) => {
			libraryScanCalls.push(libraryId);

			return Promise.resolve();
		});
		await recordLibraryScan("lib-1", clock.now() - 2 * HOUR);
		await recordLibraryScan("lib-2", clock.now());
		systemSettingsStore.setRuntimeValue("scanning.scheduledScanIntervalHours", 1);

		try {
			await service.runScheduledScanIfDue();
			expect(libraryScanCalls).toEqual(["lib-1"]);
		} finally {
			cleanup();
		}
	});

	test("a database failure does not surface from the detached reconcile tick", async () => {
		const { service, cleanup } = createHarness();
		await seedLibraryPaths();
		const libraryScanCalls: string[] = [];
		service.registerLibraryScanner((libraryId) => {
			libraryScanCalls.push(libraryId);

			return Promise.resolve();
		});
		stubs.push(stubMethod(workerOperationRepository, "findLatestLibraryScanTimes", () => Promise.reject(new Error("database is locked"))));
		systemSettingsStore.setRuntimeValue("scanning.scheduledScanIntervalHours", 1);

		try {
			await expect(service.runScheduledScanIfDue()).resolves.toBeUndefined();
			expect(libraryScanCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});
});
