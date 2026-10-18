import { adminFailureNotificationService } from "@/app/admin/admin-failure-notification.service";
import type { UpdateComponent } from "@/app/updates/update-environment.utils";
import { updateHistoryService } from "@/app/updates/update-history.service";
import { swapBackFromPrevious } from "@/app/updates/update-swap.utils";
import { SERVER_VERSION } from "@/config/version.constants";
import { errorCodeOf } from "@/utils/domain.errors";
import { setJob, setLastError, type UpdateInstallState } from "./shared.types";

/**
 * Swaps the previous version back into place. Returns the failure code, or null when the swap went through.
 * On Windows the server swap happens in the post-exit script, so this only marks the job as restarting.
 */
export function runRollback(state: UpdateInstallState, target: UpdateComponent): string | null {
	try {
		if (target === "web") {
			// Static files — the rollback swap is live immediately, no restart.
			const restoredVersion = swapBackFromPrevious(state.root, "web");
			state.job = null;
			state.logger.info(`Web UI rolled back to ${restoredVersion} — live without a restart`, {});
		} else if (process.platform === "win32") {
			// The swap of locked directories happens in the post-exit script.
			setJob(state, "restarting", 97, null);
		} else {
			const restoredVersion = swapBackFromPrevious(state.root, "server");
			setJob(state, "restarting", 97, null);
			state.logger.info(`Rolling server back to ${restoredVersion} — restarting`, { runningVersion: SERVER_VERSION });
		}

		return null;
	} catch (error) {
		const errorCode = errorCodeOf(error, "update.rollback_failed");
		setLastError(state, target, errorCode);
		state.job = null;
		state.logger.error(`Rollback for ${target} failed`, error);
		adminFailureNotificationService.notifyUpdateFailed(target, null);

		return errorCode;
	}
}

/**
 * Records a rollback run, then schedules the server restart when the swap went through.
 * The run is written before the restart, so the row survives the restart.
 */
export async function recordRollback(
	state: UpdateInstallState,
	run: { target: UpdateComponent; fromVersion: string | null; restoredVersion: string; actorUserId: string | null },
	failure: string | null,
): Promise<void> {
	const historyId = await updateHistoryService.begin({
		action: "rollback",
		target: run.target,
		fromVersion: run.fromVersion,
		toVersion: run.restoredVersion,
		actorUserId: run.actorUserId,
	});
	if (failure) {
		await updateHistoryService.fail(historyId, failure);

		return;
	}
	if (run.target === "web") {
		await updateHistoryService.succeed(historyId);

		return;
	}

	state.restartScheduler.scheduleRestart(state.root);
}
