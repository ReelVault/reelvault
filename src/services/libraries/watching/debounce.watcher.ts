import { join } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { isIgnoredRelativePath } from "@/modules/scanner/disk/file.scanner";
import { serverRescueService } from "@/system/server-rescue.service";
import { isWatcherPathSuppressed } from "@/utils/watcher-write-suppression.utils";
import type { LibraryWatcherState } from "./state.types";
import { armTimer, RESCUE_RECHECK_MS } from "./timing.utils";

/** The library path a filesystem event belongs to. */
interface WatchedTarget {
	libraryId: string;
	pathId: string;
	rootPath: string;
}

/**
 * Entry point for fs events. A burst of changes re-arms one debounce timer per
 * path; the scan fires once the disk has been quiet for the configured delay.
 */
export function handleFsEvent(state: LibraryWatcherState, target: WatchedTarget, eventType: string, filename: string | null): void {
	if (state.isShuttingDown || !serverConfig.scanning.autoWatcherEnabled) return;

	// Filter out temporary and hidden files, and writes this process just made
	// (sidecar NFOs/artwork use atomic rename, which emits an event for the target).
	if (filename && (isIgnoredRelativePath(filename) || isWatcherPathSuppressed(join(target.rootPath, filename)))) {
		return;
	}

	state.logger.debug("Filesystem change detected in library path", {
		libraryId: target.libraryId,
		pathId: target.pathId,
		eventType,
		filename: filename ?? "(unknown)",
	});

	const scanKey = `${target.libraryId}:${target.pathId}`;
	const existing = state.pendingScans.get(scanKey);
	if (existing) {
		state.clock.clearTimeout(existing.timer);
	}

	// Re-arm the quiet window, but never let a continuous writer defer the scan
	// forever. The first event of the burst starts a hard ceiling; once it is
	// reached, the next tick fires even if events keep arriving.
	const now = state.clock.now();
	const quietMs = Math.max(2, serverConfig.scanning.autoWatcherDelaySeconds) * 1000;
	const maxDeferralMs = quietMs * 2;
	const firstEventAt = existing?.firstEventAt ?? now;
	const delayMs = Math.min(quietMs, Math.max(0, firstEventAt + maxDeferralMs - now));

	state.pendingScans.set(scanKey, {
		timer: armScanTimer(state, scanKey, target, delayMs),
		firstEventAt,
	});
}

function armScanTimer(state: LibraryWatcherState, scanKey: string, target: WatchedTarget, delayMs: number): unknown {
	return armTimer(state.clock, () => fireScan(state, scanKey, target), delayMs);
}

/** Holds a pending scan for another `delayMs`, replacing its timer. */
function rearmScan(state: LibraryWatcherState, scanKey: string, target: WatchedTarget, pending: { timer: unknown }, delayMs: number): void {
	state.clock.clearTimeout(pending.timer);
	pending.timer = armScanTimer(state, scanKey, target, delayMs);
}

async function fireScan(state: LibraryWatcherState, scanKey: string, target: WatchedTarget): Promise<void> {
	const pending = state.pendingScans.get(scanKey);
	if (!pending) return;

	const { libraryId, pathId, rootPath } = target;

	if (state.isShuttingDown || !serverConfig.scanning.autoWatcherEnabled) {
		state.clock.clearTimeout(pending.timer);
		state.pendingScans.delete(scanKey);

		return;
	}

	const delaySeconds = serverConfig.scanning.autoWatcherDelaySeconds;

	// Server rescue active: background work is paused, so hold the scan (the pending
	// entry stays alive) and re-check until the system recovers.
	if (serverRescueService.isThrottling()) {
		rearmScan(state, scanKey, target, pending, RESCUE_RECHECK_MS);
		state.logger.debug("Filesystem changes held: server rescue is active, scan postponed", { libraryId, pathId });

		return;
	}

	// Cooldown: minimum gap between two watcher-triggered scans of the same path.
	// During bulk copies the debounce fires after every quiet gap; the cooldown
	// collapses those into one scan per window. The pending entry stays alive so
	// the final catch-up scan still runs when the cooldown expires.
	const cooldownUntil = state.cooldowns.get(scanKey) ?? 0;
	const remainingMs = cooldownUntil - state.clock.now();
	if (remainingMs > 0) {
		rearmScan(state, scanKey, target, pending, remainingMs);
		state.logger.debug("Filesystem changes held: scan cooldown active", {
			libraryId,
			pathId,
			remainingMs,
		});

		return;
	}

	state.pendingScans.delete(scanKey);
	const cooldownSeconds = serverConfig.scanning.autoWatcherCooldownSeconds;
	if (cooldownSeconds > 0) {
		state.cooldowns.set(scanKey, state.clock.now() + cooldownSeconds * 1000);
	} else {
		state.cooldowns.delete(scanKey);
	}

	state.logger.info("Filesystem changes settled, triggering automatic library scan", {
		libraryId,
		pathId,
		rootPath,
		delaySeconds,
		cooldownSeconds,
	});

	try {
		await state.scanPathFn?.(libraryId, pathId);
	} catch (error) {
		state.logger.error("Failed to automatically scan library path after changes settled", error, {
			libraryId,
			pathId,
			rootPath,
		});
	}
}
