import { resolveWebVersion } from "@/config/server/web-dist.utils";
import { SERVER_VERSION } from "@/config/version.constants";
import {
	DISCARD_DIR,
	PENDING_DIR,
	readInstalledWebVersion,
	STAGING_DIR,
	type UpdateComponent,
} from "@/services/updates/update-environment.utils";
import { updateHistoryService } from "@/services/updates/update-history.service";
import { readPreviousVersion } from "@/services/updates/update-swap.utils";
import { DomainError } from "@/utils/domain.errors";
import { detach } from "@/utils/promise.utils";
import { runInstall } from "./install.runner";
import { assertDiskSpace, assertInstallPreconditions, assertNoActiveStreams, assertRollbackPreconditions } from "./preconditions.guard";
import { recordRollback, runRollback } from "./rollback.service";
import {
	beginJob,
	removeScratchDirectories,
	setLastError,
	type UpdateActionOptions,
	type UpdateInstallState,
	type UpdateJobState,
} from "./shared.types";

/** An install can be cancelled until its first file is replaced; the swap itself always completes. */
const CANCELLABLE_STATES: ReadonlySet<UpdateJobState> = new Set(["downloading", "verifying", "extracting"]);

export async function startInstall(
	state: UpdateInstallState,
	target: UpdateComponent,
	actorUserId: string | null,
	options: UpdateActionOptions,
): Promise<{ started: boolean; target: UpdateComponent; version: string }> {
	const release = await assertInstallPreconditions(state, target);
	await assertDiskSpace(state, target, release);
	assertNoActiveStreams(state, target, options.force === true);
	if (state.job) throw new DomainError("conflict", "An update is already in progress", { code: "update.install_already_running" });

	state.cancelController = new AbortController();
	beginJob(state, target, "downloading", 5, release.version);
	setLastError(state, target, null);
	// The run is on record before any restart it may trigger, so the row survives the restart.
	const historyId = await updateHistoryService.begin({
		action: "install",
		target,
		fromVersion: installedVersion(state, target),
		toVersion: release.version,
		actorUserId,
	});

	detach(runInstall(state, target, release, historyId));

	return { started: true, target, version: release.version };
}

export function startRollback(
	state: UpdateInstallState,
	target: UpdateComponent,
	actorUserId: string | null,
	options: UpdateActionOptions,
): { started: boolean; target: UpdateComponent; version: string } {
	assertRollbackPreconditions(state, target);
	assertNoActiveStreams(state, target, options.force === true);
	const restoredVersion = readPreviousVersion(state.root, target);
	const fromVersion = installedVersion(state, target);

	beginJob(state, target, "swapping", 90, restoredVersion);

	const failure = runRollback(state, target);
	detach(recordRollback(state, { target, fromVersion, restoredVersion, actorUserId }, failure));

	return { started: true, target, version: restoredVersion };
}

/**
 * Stops an install that has not replaced any file yet. The download aborts at once; the
 * extraction and checksum stages stop at their next checkpoint. A swap in progress always completes.
 */
export function cancelInstall(state: UpdateInstallState, target: UpdateComponent): { target: UpdateComponent } {
	const job = state.job;
	if (!job || job.target !== target) {
		throw new DomainError("not_found", `No ${target} update is running`, { code: "update.not_running" });
	}
	if (!CANCELLABLE_STATES.has(job.state)) {
		throw new DomainError("conflict", "The update is already replacing files and can no longer be cancelled", {
			code: "update.not_cancellable",
			params: { state: job.state },
		});
	}

	state.cancelController?.abort();

	return { target };
}

/** Removes scratch directories left behind by an interrupted update. */
export function cleanupStaleArtifacts(state: UpdateInstallState): void {
	if (state.job) return;

	removeScratchDirectories(state, [STAGING_DIR, PENDING_DIR, DISCARD_DIR], (dir, error) =>
		state.logger.debug("Could not remove stale update directory", { dir, error }),
	);
}

/** The version a run replaces: the running server, or the installed web UI. */
function installedVersion(state: UpdateInstallState, target: UpdateComponent): string | null {
	if (target === "server") return SERVER_VERSION;

	return readInstalledWebVersion(state.root) ?? resolveWebVersion();
}
