import { join } from "node:path";
import type { ArchiveFetcher } from "@/plugins/catalog/plugin-package/download.fetcher";
import type { UpdateComponent, UpdateFlavor, UpdateInstallType } from "@/services/updates/update-environment.utils";
import { removeTreeSync } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import type { createLogger } from "@/utils/logger.utils";

/** Caller options for an install or rollback. `force` lets a server restart go ahead while streams play. */
export interface UpdateActionOptions {
	force?: boolean | undefined;
}

export type UpdateJobState = "downloading" | "verifying" | "extracting" | "swapping" | "restarting";

export interface UpdateJob {
	target: UpdateComponent;
	state: UpdateJobState;
	progressPercent: number;
	message: string | null;
	startedAt: string;
	targetVersion: string;
}

/**
 * Restarts the server after the server component has been swapped. Windows
 * defers the swap itself to a post-exit script (running executables lock their
 * files). Web updates never restart — the static dist is live after the swap.
 */
export interface RestartScheduler {
	scheduleRestart(root: string): void;
}

/** The install service's collaborators and its mutable run state. */
export interface UpdateInstallState {
	readonly serviceName: string;
	readonly logger: ReturnType<typeof createLogger>;
	readonly restartScheduler: RestartScheduler;
	readonly archiveFetcher: ArchiveFetcher | undefined;
	readonly countActiveStreams: () => number;
	readonly root: string;
	readonly installType: UpdateInstallType;
	readonly flavor: UpdateFlavor;
	job: UpdateJob | null;
	cancelController: AbortController | null;
	lastServerError: string | null;
	lastWebError: string | null;
}

export function setJob(state: UpdateInstallState, jobState: UpdateJobState, progressPercent: number, message: string | null): void {
	if (!state.job) return;

	state.job = { ...state.job, state: jobState, progressPercent, message };
}

export function beginJob(
	state: UpdateInstallState,
	target: UpdateComponent,
	jobState: UpdateJobState,
	progressPercent: number,
	targetVersion: string,
): void {
	state.job = { target, state: jobState, progressPercent, message: null, startedAt: new Date().toISOString(), targetVersion };
}

export function setLastError(state: UpdateInstallState, target: UpdateComponent, message: string | null): void {
	if (target === "server") state.lastServerError = message;
	else state.lastWebError = message;
}

/** Checkpoint between stages: a cancelled install stops here, before anything is replaced. */
export function assertNotCancelled(state: UpdateInstallState): void {
	if (state.cancelController?.signal.aborted) {
		throw new DomainError("conflict", "The update was cancelled", { code: "update.cancelled" });
	}
}

export function removeScratchDirectories(
	state: UpdateInstallState,
	directories: readonly string[],
	onError?: (dir: string, error: unknown) => void,
): void {
	for (const dir of directories) {
		try {
			removeTreeSync(join(state.root, dir));
		} catch (error) {
			onError?.(dir, error);
		}
	}
}
