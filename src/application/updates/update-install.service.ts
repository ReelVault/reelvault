import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { adminFailureNotificationService } from "@/application/admin/admin-failure-notification.service";
import { databaseBackupService } from "@/application/admin/database-backup.service";
import { databaseMaintenanceService } from "@/application/admin/database-maintenance.service";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { type ArchiveFetcher, downloadArchive, extractArchive } from "@/plugins/catalog/plugin-package.utils";
import { requestApplicationRestart } from "@/shutdown";
import { BaseService } from "@/utils/base-service";
import { ConflictError, NotFoundError, ValidationError } from "@/utils/errors";
import { detach } from "@/utils/promise.utils";
import { isNewerVersion } from "@/utils/semver.utils";
import { isRecord } from "@/utils/type.utils";
import { guardedFetch } from "@/utils/url-guard.utils";
import { SERVER_VERSION } from "@/version";
import { resolveWebVersion } from "@/web/web-dist";
import { updateCheckService } from "./update-check.service";
import {
	DISCARD_DIR,
	detectFlavor,
	detectInstallType,
	isPreviousVersionPresent,
	LAUNCHER_FILE_NAMES,
	PENDING_DIR,
	PREVIOUS_DIR,
	readInstalledWebVersion,
	resolveInstallRoot,
	SERVER_DIR_NAMES,
	STAGING_DIR,
	systemdServiceRegistered,
	type UpdateComponent,
	type UpdateFlavor,
	type UpdateInstallType,
} from "./update-environment";
import { updateHistoryService } from "./update-history.service";
import { assertChecksumMatches, checksumForFile, serverAssetName, webAssetName } from "./update-release.utils";
import { readPreviousVersion, swapBackFromPrevious, swapIntoPlace, swapWebDirectory } from "./update-swap.utils";

/** Release archives reach ~250 MB compressed (~1 GB uncompressed with ffmpeg). */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
/** A slow line downloading the archive needs far more than the plugin default. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/**
 * The download, its unpacked copy and the swap sit side by side on the disk, and an archive expands
 * about four times, so an install needs this many times its archive's size free.
 */
const DISK_HEADROOM_FACTOR = 5;

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

/** An install can be cancelled until its first file is replaced; the swap itself always completes. */
const CANCELLABLE_STATES: ReadonlySet<UpdateJobState> = new Set(["downloading", "verifying", "extracting"]);

/**
 * Restarts the server after the server component has been swapped. Windows
 * defers the swap itself to a post-exit script (running executables lock their
 * files). Web updates never restart — the static dist is live after the swap.
 */
export interface RestartScheduler {
	scheduleRestart(root: string): void;
}

interface UpdateServiceOptions {
	root?: string | undefined;
	installType?: UpdateInstallType | undefined;
	flavor?: UpdateFlavor | undefined;
	restartScheduler?: RestartScheduler | undefined;
	/** Test seam — overrides the SSRF-guarded fetcher for archive downloads. */
	archiveFetcher?: ArchiveFetcher | undefined;
	/** Test seam — counts the streams a server restart would end; defaults to the live streaming manager. */
	countActiveStreams?: (() => number) | undefined;
}

export class UpdateInstallService extends BaseService {
	private readonly restartScheduler: RestartScheduler;
	private readonly archiveFetcher: ArchiveFetcher | undefined;
	private readonly countActiveStreams: () => number;
	private readonly root: string;
	private readonly installType: UpdateInstallType;
	private readonly flavor: UpdateFlavor;
	private job: UpdateJob | null = null;
	private cancelController: AbortController | null = null;
	private lastServerError: string | null = null;
	private lastWebError: string | null = null;

	constructor(options: UpdateServiceOptions = {}) {
		super("UpdateInstallService");
		const root = options.root ?? resolveInstallRoot();
		this.root = root;
		this.installType = options.installType ?? detectInstallType(root);
		this.flavor = options.flavor ?? detectFlavor(root);
		this.restartScheduler = options.restartScheduler ?? defaultRestartScheduler();
		this.archiveFetcher = options.archiveFetcher;
		this.countActiveStreams = options.countActiveStreams ?? (() => streamingManager.getAllActiveSessions().length);
	}

	getJob(): UpdateJob | null {
		return this.job;
	}

	getLastError(target: UpdateComponent): string | null {
		return target === "server" ? this.lastServerError : this.lastWebError;
	}

	getInstallType(): UpdateInstallType {
		return this.installType;
	}

	getFlavor(): UpdateFlavor {
		return this.flavor;
	}

	isRollbackAvailable(target: UpdateComponent): boolean {
		return this.installType === "archive" && isPreviousVersionPresent(target, this.root);
	}

	/** Removes scratch directories left behind by an interrupted update. */
	cleanupStaleArtifacts(): void {
		if (this.job) return;

		this.removeScratchDirectories([STAGING_DIR, PENDING_DIR, DISCARD_DIR], (dir, error) =>
			this.logger.debug("Could not remove stale update directory", { dir, error }),
		);
	}

	async startInstall(
		target: UpdateComponent,
		actorUserId: string | null = null,
		options: UpdateActionOptions = {},
	): Promise<{ started: boolean; target: UpdateComponent; version: string }> {
		const release = await this.assertInstallPreconditions(target);
		await this.assertDiskSpace(target, release);
		this.assertNoActiveStreams(target, options.force === true);
		if (this.job) throw new ConflictError("An update is already in progress", { code: "update.install_already_running" });

		this.cancelController = new AbortController();
		this.beginJob(target, "downloading", 5, release.version);
		this.setLastError(target, null);
		// The run is on record before any restart it may trigger, so the row survives the restart.
		const historyId = await updateHistoryService.begin({
			action: "install",
			target,
			fromVersion: this.installedVersion(target),
			toVersion: release.version,
			actorUserId,
		});

		detach(this.runInstall(target, release, historyId));

		return { started: true, target, version: release.version };
	}

	startRollback(
		target: UpdateComponent,
		actorUserId: string | null = null,
		options: UpdateActionOptions = {},
	): { started: boolean; target: UpdateComponent; version: string } {
		this.assertRollbackPreconditions(target);
		this.assertNoActiveStreams(target, options.force === true);
		const restoredVersion = readPreviousVersion(this.root, target);
		const fromVersion = this.installedVersion(target);

		this.beginJob(target, "swapping", 90, restoredVersion);

		const failure = this.runRollback(target);
		detach(this.recordRollback({ target, fromVersion, restoredVersion, actorUserId }, failure));

		return { started: true, target, version: restoredVersion };
	}

	/**
	 * Stops an install that has not replaced any file yet. The download aborts at once; the
	 * extraction and checksum stages stop at their next checkpoint. A swap in progress always completes.
	 */
	cancelInstall(target: UpdateComponent): { target: UpdateComponent } {
		const job = this.job;
		if (!job || job.target !== target) {
			throw new NotFoundError(`No ${target} update is running`, { code: "update.not_running" });
		}
		if (!CANCELLABLE_STATES.has(job.state)) {
			throw new ConflictError("The update is already replacing files and can no longer be cancelled", {
				code: "update.not_cancellable",
				params: { state: job.state },
			});
		}

		this.cancelController?.abort();

		return { target };
	}

	/** Refuses an install the disk cannot hold, before anything is downloaded. */
	private async assertDiskSpace(target: UpdateComponent, release: AdminUpdateRelease): Promise<void> {
		const assetName =
			target === "server" ? serverAssetName(process.platform, process.arch, release.version) : webAssetName(release.version);
		const asset = release.assets.find((item) => item.name === assetName);
		if (!asset) return; // runInstall reports a missing archive with its own code

		const stats = await statfs(this.root).catch(() => null);
		if (!stats) return; // free space cannot be read here; a disk that fills up still fails the install loudly

		const requiredBytes = asset.size * DISK_HEADROOM_FACTOR;
		const freeBytes = stats.bavail * stats.bsize;
		if (freeBytes < requiredBytes) {
			throw new ValidationError("The disk does not have enough free space for this update", {
				code: "update.insufficient_disk_space",
				params: { requiredBytes, freeBytes },
			});
		}
	}

	private assertInstallPreconditions(target: UpdateComponent): Promise<AdminUpdateRelease> {
		if (this.installType !== "archive") {
			throw new ValidationError(
				this.installType === "docker"
					? "Docker installs are updated by pulling a new image"
					: "Self-update is unavailable for this install type",
				{ code: "update.install_unsupported_install_type" },
			);
		}
		if (this.job) {
			throw new ConflictError("An update is already in progress", { code: "update.install_already_running" });
		}

		return this.assertNewerReleaseAvailable(target);
	}

	private assertRollbackPreconditions(target: UpdateComponent): void {
		if (this.installType !== "archive") {
			throw new ValidationError("Rollback is only available for archive installs", { code: "update.install_unsupported_install_type" });
		}
		if (this.job) {
			throw new ConflictError("An update is already in progress", { code: "update.install_already_running" });
		}
		if (!isPreviousVersionPresent(target, this.root)) {
			throw new ValidationError(`No previous ${target} version is available to roll back to`, { code: "update.no_previous_version" });
		}
	}

	/**
	 * A server restart ends every stream, so a server install or rollback waits until none play, unless the
	 * caller forces it. A web swap is live without a restart and is never held back.
	 */
	private assertNoActiveStreams(target: UpdateComponent, force: boolean): void {
		if (target !== "server" || force) return;

		const activeStreams = this.countActiveStreams();
		if (activeStreams > 0) {
			throw new ConflictError("A server update is blocked while streams are active", {
				code: "update.blocked_active_streams",
				params: { activeStreams },
			});
		}
	}

	/** Checkpoint between stages: a cancelled install stops here, before anything is replaced. */
	private assertNotCancelled(): void {
		if (this.cancelController?.signal.aborted) {
			throw new ConflictError("The update was cancelled", { code: "update.cancelled" });
		}
	}

	/** A cancelled install leaves the running version alone, removes its scratch files and records no failure. */
	private async finishCancelledInstall(target: UpdateComponent, historyId: string | null): Promise<void> {
		this.logger.info(`Update install for ${target} cancelled`);
		this.job = null;
		this.removeScratchDirectories([STAGING_DIR, PENDING_DIR]);
		await updateHistoryService.cancel(historyId);
	}

	private async assertNewerReleaseAvailable(target: UpdateComponent): Promise<AdminUpdateRelease> {
		await updateCheckService.checkLatest(true);
		const state = updateCheckService.getState();
		const release = target === "server" ? state.serverLatest : state.webLatest;
		if (!release) {
			throw new ValidationError(`No ${target} release information is available — check for updates first`, {
				code: "update.no_release_info",
			});
		}

		if (target === "server") {
			if (!isNewerVersion(release.version, SERVER_VERSION)) {
				throw new ValidationError(`ReelVault server ${SERVER_VERSION} is already up to date`, { code: "update.up_to_date" });
			}
		} else {
			const webVersion = readInstalledWebVersion(this.root) ?? resolveWebVersion();
			if (!(webVersion && isNewerVersion(release.version, webVersion))) {
				throw new ValidationError(`The web UI ${webVersion ?? "(version unknown)"} is already up to date`, { code: "update.up_to_date" });
			}

			// The web release declares the oldest server it works with. The UI only warns;
			// this is the actual gate, so the API and dashboard cannot bypass it.
			if (release.minServerVersion && isNewerVersion(release.minServerVersion, SERVER_VERSION)) {
				throw new ValidationError(
					`Web UI ${release.version} requires server ${release.minServerVersion} or newer (running ${SERVER_VERSION}) — update the server first`,
					{ code: "update.server_too_old" },
				);
			}
		}

		return release;
	}

	private async runInstall(target: UpdateComponent, release: AdminUpdateRelease, historyId: string | null): Promise<void> {
		try {
			const assetName =
				target === "server" ? serverAssetName(process.platform, process.arch, release.version) : webAssetName(release.version);
			const asset = release.assets.find((item) => item.name === assetName);
			if (!asset) {
				throw new ValidationError(`Release ${release.version} has no archive for this component (${assetName})`, {
					code: "update.asset_missing",
				});
			}
			const sumsAsset = release.assets.find((item) => item.name === "SHA256SUMS.txt");
			if (!sumsAsset) {
				throw new ValidationError("Release assets are missing SHA256SUMS.txt", { code: "update.checksums_missing" });
			}

			this.setJob("downloading", 10, assetName);
			const download = await downloadArchive(asset.url, {
				maxBytes: MAX_ARCHIVE_BYTES,
				timeoutMs: DOWNLOAD_TIMEOUT_MS,
				signal: this.cancelController?.signal,
				fetcher: this.archiveFetcher,
				onProgress: (received, total) => {
					const percent = total > 0 ? 5 + Math.min(55, Math.round((received / total) * 55)) : 10;
					this.setJob("downloading", percent, assetName);
				},
			});

			try {
				this.setJob("verifying", 65, "SHA256SUMS.txt");
				const expected = checksumForFile(await this.fetchText(sumsAsset.url), assetName);
				if (!expected) {
					throw new ValidationError(`SHA256SUMS.txt has no entry for ${assetName}`, { code: "update.checksum_mismatch" });
				}
				assertChecksumMatches(download.checksum, expected);
				this.assertNotCancelled();

				if (target === "web") {
					await this.applyWebUpdate(download.filePath, release.version);
					await updateHistoryService.succeed(historyId);
				} else {
					const note = await this.preUpdateCheck();
					await this.applyServerUpdate(download.filePath, release.version);
					// The swap has set the restart state; the note stays on the job until the restarted server takes over.
					this.setJob("restarting", 97, note);
				}
			} finally {
				await download.cleanup();
			}
		} catch (error) {
			if (this.cancelController?.signal.aborted) {
				await this.finishCancelledInstall(target, historyId);

				return;
			}

			const message = error instanceof Error ? error.message : "unknown error";
			this.setLastError(target, message);
			this.job = null;
			this.logger.error(`Update install for ${target} failed`, error);
			// staging cleanup must never mask the original failure
			this.removeScratchDirectories([STAGING_DIR, PENDING_DIR]);
			adminFailureNotificationService.notifyUpdateFailed(target, release.version);
			await updateHistoryService.fail(historyId, message);
		}
	}

	/**
	 * The web dist is static — swapping the directory makes it live immediately
	 * (index.html is served no-cache and re-read on change), no restart needed.
	 */
	private async applyWebUpdate(archivePath: string, version: string): Promise<void> {
		const stagingRoot = join(this.root, STAGING_DIR);
		this.setJob("extracting", 75, null);
		this.resetDirectory(stagingRoot);
		// The web zip carries the dist contents at its root — the extraction
		// directory itself becomes the new `web/`.
		await extractArchive(archivePath, stagingRoot, MAX_UNCOMPRESSED_BYTES);
		if (!existsSync(join(stagingRoot, "index.html"))) {
			throw new ValidationError("The extracted web release has an unexpected layout", { code: "update.unexpected_layout" });
		}

		this.assertNotCancelled();
		this.setJob("swapping", 90, null);
		const replacedWebVersion = readInstalledWebVersion(this.root) ?? "";
		swapWebDirectory(this.root, stagingRoot, replacedWebVersion);

		this.job = null;
		this.logger.info(`Web UI updated to ${version} — live without a restart`, { previousVersion: replacedWebVersion });
	}

	private async applyServerUpdate(archivePath: string, version: string): Promise<void> {
		if (process.platform === "win32") {
			// Running executables lock their files: extract now, swap after exit.
			const pendingRoot = join(this.root, PENDING_DIR);
			this.assertNotCancelled();
			this.setJob("swapping", 85, null);
			this.resetDirectory(pendingRoot);
			await extractArchive(archivePath, pendingRoot, MAX_UNCOMPRESSED_BYTES);
			this.assertServerStagedLayout(join(pendingRoot, "ReelVault"));

			this.setJob("restarting", 97, null);
			this.restartScheduler.scheduleRestart(this.root);
		} else {
			const stagingRoot = join(this.root, STAGING_DIR);
			this.setJob("extracting", 75, null);
			this.resetDirectory(stagingRoot);
			await extractArchive(archivePath, stagingRoot, MAX_UNCOMPRESSED_BYTES);
			const stagedApp = join(stagingRoot, "ReelVault");
			this.assertServerStagedLayout(stagedApp);

			this.assertNotCancelled();
			this.setJob("swapping", 90, null);
			swapIntoPlace(this.root, stagedApp, "server", this.installedServerVersion());
			// The staging root now holds only the emptied ReelVault directory.
			rmSync(stagingRoot, { recursive: true, force: true });

			this.setJob("restarting", 97, null);
			this.restartScheduler.scheduleRestart(this.root);
		}

		this.logger.info(`Server updated to ${version} — restarting`);
	}

	private runRollback(target: UpdateComponent): string | null {
		try {
			if (target === "web") {
				// Static files — the rollback swap is live immediately, no restart.
				const restoredVersion = swapBackFromPrevious(this.root, "web");
				this.job = null;
				this.logger.info(`Web UI rolled back to ${restoredVersion} — live without a restart`, {});
			} else if (process.platform === "win32") {
				// The swap of locked directories happens in the post-exit script.
				this.setJob("restarting", 97, null);
			} else {
				const restoredVersion = swapBackFromPrevious(this.root, "server");
				this.setJob("restarting", 97, null);
				this.logger.info(`Rolling server back to ${restoredVersion} — restarting`, { runningVersion: SERVER_VERSION });
			}

			return null;
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown error";
			this.setLastError(target, message);
			this.job = null;
			this.logger.error(`Rollback for ${target} failed`, error);
			adminFailureNotificationService.notifyUpdateFailed(target, null);

			return message;
		}
	}

	/**
	 * Records a rollback run, then schedules the server restart when the swap went through.
	 * The run is written before the restart, so the row survives the restart.
	 */
	private async recordRollback(
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

		this.restartScheduler.scheduleRestart(this.root);
	}

	/** The version a run replaces: the running server, or the installed web UI. */
	private installedVersion(target: UpdateComponent): string | null {
		if (target === "server") return SERVER_VERSION;

		return readInstalledWebVersion(this.root) ?? resolveWebVersion();
	}

	/**
	 * Copies the database and runs SQLite's quick check on the copy before any file is replaced.
	 * A failed check stops the update here, so a damaged database is never upgraded. The returned
	 * note names the copy and stays on the job until the restarted server takes over.
	 */
	private async preUpdateCheck(): Promise<string> {
		this.setJob("verifying", 70, "database backup");
		const backup = await databaseBackupService.createBackup();
		const integrity = await databaseMaintenanceService.checkIntegrity();
		if (!integrity.ok) {
			throw new ValidationError("The database failed its integrity check, so the update was not installed", {
				code: "update.database_integrity_failed",
				params: { backup: backup.fileName },
			});
		}

		return `database backup ${backup.fileName}, integrity check passed`;
	}

	/** Server archives keep the classic `ReelVault/` layout minus `web/`. */
	private assertServerStagedLayout(stagedApp: string): void {
		if (!existsSync(join(stagedApp, "server", "package.json"))) {
			throw new ValidationError("The extracted release archive has an unexpected layout", { code: "update.unexpected_layout" });
		}
	}

	/**
	 * The version of the installed server layout, read from its package.json —
	 * the rollback marker must describe what is being replaced, not the running
	 * process (which normally matches, but the layout is the source of truth).
	 */
	private installedServerVersion(): string {
		try {
			const manifest: unknown = JSON.parse(readFileSync(join(this.root, "server", "package.json"), "utf8"));
			if (isRecord(manifest) && typeof manifest.version === "string" && manifest.version.length > 0) return manifest.version;
		} catch {
			// Missing/unreadable layout — fall back to the running version below.
		}

		return SERVER_VERSION;
	}

	private setJob(state: UpdateJobState, progressPercent: number, message: string | null): void {
		if (!this.job) return;

		this.job = { ...this.job, state, progressPercent, message };
	}

	private beginJob(target: UpdateComponent, state: UpdateJobState, progressPercent: number, targetVersion: string): void {
		this.job = { target, state, progressPercent, message: null, startedAt: new Date().toISOString(), targetVersion };
	}

	private setLastError(target: UpdateComponent, message: string | null): void {
		if (target === "server") this.lastServerError = message;
		else this.lastWebError = message;
	}

	private resetDirectory(path: string): void {
		rmSync(path, { recursive: true, force: true });
		mkdirSync(path, { recursive: true });
	}

	private removeScratchDirectories(directories: readonly string[], onError?: (dir: string, error: unknown) => void): void {
		for (const dir of directories) {
			try {
				rmSync(join(this.root, dir), { recursive: true, force: true });
			} catch (error) {
				onError?.(dir, error);
			}
		}
	}

	private async fetchText(url: string): Promise<string> {
		const fetcher = this.archiveFetcher ?? guardedFetch;
		const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
		if (!response.ok)
			throw new ValidationError(`Checksum listing download failed with HTTP ${response.status}`, { code: "update.checksums_missing" });

		return await response.text();
	}
}

function defaultRestartScheduler(): RestartScheduler {
	return {
		scheduleRestart(root: string): void {
			if (process.platform === "win32") {
				writeWindowsSwapScript(root);
			} else if (systemdServiceRegistered()) {
				// systemd stops (graceful SIGTERM) and starts the unit in one call —
				// the exit code of the running process becomes irrelevant.
				detachedSpawn("systemctl", ["--user", "restart", "reelvault"]);
			} else {
				// No supervisor: a detached helper waits for this process to exit and
				// relaunches the already-swapped application.
				detachedSpawn("sh", [
					"-c",
					'while kill -0 "$1" 2>/dev/null; do sleep 0.5; done; cd "$2" && exec ./start.sh',
					"sh",
					String(process.pid),
					root,
				]);
			}
			requestApplicationRestart();
		},
	};
}

/**
 * Writes a batch script that waits for the server process to exit, swaps the
 * application directories and relaunches. Spawned detached, it outlives the
 * shutting-down server.
 */
function writeWindowsSwapScript(root: string): void {
	const script = join(root, "apply-update.cmd");
	const pid = process.pid;
	const scriptLines = [
		"@echo off",
		'set "ROOT=%~dp0"',
		":wait",
		`tasklist /FI "PID eq ${pid}" 2>NUL | find "${pid}" >NUL`,
		"if not errorlevel 1 ( timeout /t 1 /nobreak >NUL & goto wait )",
		`if exist "%ROOT%\\${PREVIOUS_DIR}" rmdir /s /q "%ROOT%\\${PREVIOUS_DIR}"`,
		`mkdir "%ROOT%\\${PREVIOUS_DIR}"`,
	];

	for (const name of [...SERVER_DIR_NAMES, ...LAUNCHER_FILE_NAMES]) {
		scriptLines.push(
			`if exist "%ROOT%\\${name}" move "%ROOT%\\${name}" "%ROOT%\\${PREVIOUS_DIR}\\${name}" >NUL`,
			`if exist "%ROOT%\\${PENDING_DIR}\\ReelVault\\${name}" move "%ROOT%\\${PENDING_DIR}\\ReelVault\\${name}" "%ROOT%\\${name}" >NUL`,
		);
	}

	scriptLines.push(
		`if exist "%ROOT%\\${PENDING_DIR}" rmdir /s /q "%ROOT%\\${PENDING_DIR}"`,
		`if exist "%ROOT%\\${DISCARD_DIR}" rmdir /s /q "%ROOT%\\${DISCARD_DIR}"`,
		'start "" "%ROOT%start.bat"',
		'del "%~f0"',
		"",
	);

	writeFileSync(script, scriptLines.filter((line) => line.length > 0).join("\r\n"));
	detachedSpawn("cmd", ["/c", "start", "", script]);
}

export function detachedSpawn(command: string, args: string[]): void {
	Bun.spawn([command, ...args], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
	});
}

export const updateInstallService = new UpdateInstallService();
