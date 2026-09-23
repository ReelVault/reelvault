import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { systemSettingsStore } from "@/config/system-settings.store";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { serverRescueService } from "@/system/server-rescue.service";
import { PathUtils } from "@/utils/path.utils";
import { type LibraryWatcherClock, LibraryWatcherService } from "./library-watcher.service";

/** Virtual time: timers run in due order; `advance` awaits each callback
 * (fireScan) so the state machine settles deterministically. */
class ManualClock implements LibraryWatcherClock<number> {
	private seq = 0;
	private readonly timers = new Map<number, { at: number; fn: () => unknown }>();
	private currentTime = 0;

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
	cleanup(): void;
}

/** State-machine harness: no real fs watchers — events are fed via handleFsEvent. */
function createHarness(options: { cooldownSeconds?: number; rescue?: () => boolean } = {}): Harness {
	const clock = new ManualClock();
	const service = new LibraryWatcherService(clock);
	const scanCalls: ScanCall[] = [];
	service.registerScanner((libraryId, pathId) => {
		scanCalls.push({ libraryId, pathId });

		return Promise.resolve({ success: true, operationId: "op-1", status: "pending" });
	});

	const rescueSpy = options.rescue ? spyOn(serverRescueService, "isThrottling").mockImplementation(options.rescue) : undefined;

	systemSettingsStore.setRuntimeValue("scanning.autoWatcherEnabled", true);
	systemSettingsStore.setRuntimeValue("scanning.autoWatcherDelaySeconds", 2);
	systemSettingsStore.setRuntimeValue("scanning.autoWatcherCooldownSeconds", options.cooldownSeconds ?? 0);

	return {
		service,
		clock,
		scanCalls,
		cleanup() {
			service.shutdown();
			rescueSpy?.mockRestore();
			systemSettingsStore.clearRuntimeValues();
		},
	};
}

function emitEvent(service: LibraryWatcherService, libraryId = "lib-1", pathId = "path-1"): void {
	service.handleFsEvent(libraryId, pathId, "/media/movies", "change", "video.mp4");
}

describe("LibraryWatcherService", () => {
	test("synchronizes active library paths and ignores non-existent paths gracefully", async () => {
		const tempDir = PathUtils.join(tmpdir(), `rv-test-watcher-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const service = new LibraryWatcherService();

		// Mock repository to return one valid path and one non-existent path
		const originalFindActive = librariesRepository.findActiveLibraryPaths;
		librariesRepository.findActiveLibraryPaths = async () => [
			{ id: "path-1", libraryId: "lib-1", path: tempDir, isActive: true },
			{ id: "path-2", libraryId: "lib-1", path: "/non/existent/path/for/reelvault/test", isActive: true },
		];

		try {
			systemSettingsStore.setRuntimeValue("scanning.autoWatcherEnabled", true);
			await service.init();

			// Only the existing directory should have an active watcher
			expect(service.getActiveWatcherCount()).toBe(1);

			// Disable auto watcher in settings and sync
			systemSettingsStore.setRuntimeValue("scanning.autoWatcherEnabled", false);
			await service.syncWatchers();
			expect(service.getActiveWatcherCount()).toBe(0);
		} finally {
			service.shutdown();
			librariesRepository.findActiveLibraryPaths = originalFindActive;
			systemSettingsStore.clearRuntimeValues();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

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

// The settings store is process-global — never leak overrides into other test files.
afterEach(() => systemSettingsStore.clearRuntimeValues());
