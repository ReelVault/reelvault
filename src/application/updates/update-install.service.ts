import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { type ArchiveFetcher, downloadArchive, extractArchive } from "@/plugins/catalog/plugin-package.utils";
import { requestApplicationRestart } from "@/shutdown";
import { BaseService } from "@/utils/base-service";
import { ConflictError, ValidationError } from "@/utils/errors";
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
import { assertChecksumMatches, checksumForFile, serverAssetName, webAssetName } from "./update-release.utils";
import { readPreviousVersion, swapBackFromPrevious, swapIntoPlace, swapWebDirectory } from "./update-swap.utils";

/** Release archives reach ~250 MB compressed (~1 GB uncompressed with ffmpeg). */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
/** A slow line downloading the archive needs far more than the plugin default. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const CHECKSUM_PREFIX_REGEX = /^sha256-/;

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

interface UpdateServiceOptions {
	root?: string | undefined;
	installType?: UpdateInstallType | undefined;
	flavor?: UpdateFlavor | undefined;
	restartScheduler?: RestartScheduler | undefined;
	/** Test seam — overrides the SSRF-guarded fetcher for archive downloads. */
	archiveFetcher?: ArchiveFetcher | undefined;
}

export class UpdateInstallService extends BaseService {
	private readonly restartScheduler: RestartScheduler;
	private readonly archiveFetcher: ArchiveFetcher | undefined;
	private readonly root: string;
	private readonly installType: UpdateInstallType;
	private readonly flavor: UpdateFlavor;
	private job: UpdateJob | null = null;
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

		for (const dir of [STAGING_DIR, PENDING_DIR, DISCARD_DIR]) {
			try {
				rmSync(join(this.root, dir), { recursive: true, force: true });
			} catch (error) {
				this.logger.debug("Could not remove stale update directory", { dir, error });
			}
		}
	}

	async startInstall(target: UpdateComponent): Promise<{ started: boolean; target: UpdateComponent; version: string }> {
		const release = await this.assertInstallPreconditions(target);
		if (this.job) throw new ConflictError("An update is already in progress", { code: "update.install_already_running" });

		this.job = {
			target,
			state: "downloading",
			progressPercent: 5,
			message: null,
			startedAt: new Date().toISOString(),
			targetVersion: release.version,
		};
		if (target === "server") this.lastServerError = null;
		else this.lastWebError = null;

		detach(this.runInstall(target, release));

		return { started: true, target, version: release.version };
	}

	startRollback(target: UpdateComponent): { started: boolean; target: UpdateComponent; version: string } {
		this.assertRollbackPreconditions(target);
		const restoredVersion = readPreviousVersion(this.root, target);

		this.job = {
			target,
			state: "swapping",
			progressPercent: 90,
			message: null,
			startedAt: new Date().toISOString(),
			targetVersion: restoredVersion,
		};

		this.runRollback(target);

		return { started: true, target, version: restoredVersion };
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

	private async runInstall(target: UpdateComponent, release: AdminUpdateRelease): Promise<void> {
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
				assertChecksumMatches(download.checksum.replace(CHECKSUM_PREFIX_REGEX, ""), expected);

				if (target === "web") {
					await this.applyWebUpdate(download.filePath, release.version);
				} else {
					await this.applyServerUpdate(download.filePath, release.version);
				}
			} finally {
				await download.cleanup();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown error";
			if (target === "server") this.lastServerError = message;
			else this.lastWebError = message;
			this.job = null;
			this.logger.error(`Update install for ${target} failed`, error);
			for (const dir of [STAGING_DIR, PENDING_DIR]) {
				try {
					rmSync(join(this.root, dir), { recursive: true, force: true });
				} catch {
					// staging cleanup must never mask the original failure
				}
			}
		}
	}

	/**
	 * The web dist is static — swapping the directory makes it live immediately
	 * (index.html is served no-cache and re-read on change), no restart needed.
	 */
	private async applyWebUpdate(archivePath: string, version: string): Promise<void> {
		const stagingRoot = join(this.root, STAGING_DIR);
		this.setJob("extracting", 75, null);
		rmSync(stagingRoot, { recursive: true, force: true });
		mkdirSync(stagingRoot, { recursive: true });
		// The web zip carries the dist contents at its root — the extraction
		// directory itself becomes the new `web/`.
		await extractArchive(archivePath, stagingRoot, MAX_UNCOMPRESSED_BYTES);
		if (!existsSync(join(stagingRoot, "index.html"))) {
			throw new ValidationError("The extracted web release has an unexpected layout", { code: "update.unexpected_layout" });
		}

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
			this.setJob("swapping", 85, null);
			rmSync(pendingRoot, { recursive: true, force: true });
			mkdirSync(pendingRoot, { recursive: true });
			await extractArchive(archivePath, pendingRoot, MAX_UNCOMPRESSED_BYTES);
			this.assertServerStagedLayout(join(pendingRoot, "ReelVault"));

			this.setJob("restarting", 97, null);
			this.restartScheduler.scheduleRestart(this.root);
		} else {
			const stagingRoot = join(this.root, STAGING_DIR);
			this.setJob("extracting", 75, null);
			rmSync(stagingRoot, { recursive: true, force: true });
			mkdirSync(stagingRoot, { recursive: true });
			await extractArchive(archivePath, stagingRoot, MAX_UNCOMPRESSED_BYTES);
			const stagedApp = join(stagingRoot, "ReelVault");
			this.assertServerStagedLayout(stagedApp);

			this.setJob("swapping", 90, null);
			swapIntoPlace(this.root, stagedApp, "server", this.installedServerVersion());
			// The staging root now holds only the emptied ReelVault directory.
			rmSync(stagingRoot, { recursive: true, force: true });

			this.setJob("restarting", 97, null);
			this.restartScheduler.scheduleRestart(this.root);
		}

		this.logger.info(`Server updated to ${version} — restarting`);
	}

	private runRollback(target: UpdateComponent): void {
		try {
			if (target === "web") {
				// Static files — the rollback swap is live immediately, no restart.
				const restoredVersion = swapBackFromPrevious(this.root, "web");
				this.job = null;
				this.logger.info(`Web UI rolled back to ${restoredVersion} — live without a restart`, {});
			} else if (process.platform === "win32") {
				// The swap of locked directories happens in the post-exit script.
				this.setJob("restarting", 97, null);
				this.restartScheduler.scheduleRestart(this.root);
			} else {
				const restoredVersion = swapBackFromPrevious(this.root, "server");
				this.setJob("restarting", 97, null);
				this.logger.info(`Rolling server back to ${restoredVersion} — restarting`, { runningVersion: SERVER_VERSION });
				this.restartScheduler.scheduleRestart(this.root);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown error";
			if (target === "server") this.lastServerError = message;
			else this.lastWebError = message;
			this.job = null;
			this.logger.error(`Rollback for ${target} failed`, error);
		}
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
