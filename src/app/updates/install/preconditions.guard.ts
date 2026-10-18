import { statfs } from "node:fs/promises";
import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { updateCheckService } from "@/app/updates/update-check.service";
import { isPreviousVersionPresent, readInstalledWebVersion, type UpdateComponent } from "@/app/updates/update-environment.utils";
import { serverAssetName, webAssetName } from "@/app/updates/update-release.utils";
import { SERVER_VERSION } from "@/config/version.constants";
import { resolveWebVersion } from "@/system/web-dist.utils";
import { DomainError } from "@/utils/domain.errors";
import { isNewerVersion } from "@/utils/semver.utils";
import type { UpdateInstallState } from "./shared.types";

/**
 * The download, its unpacked copy and the swap sit side by side on the disk, and an archive expands
 * about four times, so an install needs this many times its archive's size free.
 */
const DISK_HEADROOM_FACTOR = 5;

/** Refuses an install the disk cannot hold, before anything is downloaded. */
export async function assertDiskSpace(state: UpdateInstallState, target: UpdateComponent, release: AdminUpdateRelease): Promise<void> {
	const assetName = target === "server" ? serverAssetName(process.platform, process.arch, release.version) : webAssetName(release.version);
	const asset = release.assets.find((item) => item.name === assetName);
	if (!asset) return; // runInstall reports a missing archive with its own code

	const stats = await statfs(state.root).catch(() => null);
	if (!stats) return; // free space cannot be read here; a disk that fills up still fails the install loudly

	const requiredBytes = asset.size * DISK_HEADROOM_FACTOR;
	const freeBytes = stats.bavail * stats.bsize;
	if (freeBytes < requiredBytes) {
		throw new DomainError("validation", "The disk does not have enough free space for this update", {
			code: "update.insufficient_disk_space",
			params: { requiredBytes, freeBytes },
		});
	}
}

export function assertInstallPreconditions(state: UpdateInstallState, target: UpdateComponent): Promise<AdminUpdateRelease> {
	if (state.installType !== "archive") {
		throw new DomainError(
			"validation",
			state.installType === "docker"
				? "Docker installs are updated by pulling a new image"
				: "Self-update is unavailable for this install type",
			{ code: "update.install_unsupported_install_type" },
		);
	}
	if (state.job) {
		throw new DomainError("conflict", "An update is already in progress", { code: "update.install_already_running" });
	}

	return assertNewerReleaseAvailable(state, target);
}

export function assertRollbackPreconditions(state: UpdateInstallState, target: UpdateComponent): void {
	if (state.installType !== "archive") {
		throw new DomainError("validation", "Rollback is only available for archive installs", {
			code: "update.install_unsupported_install_type",
		});
	}
	if (state.job) {
		throw new DomainError("conflict", "An update is already in progress", { code: "update.install_already_running" });
	}
	if (!isPreviousVersionPresent(target, state.root)) {
		throw new DomainError("validation", `No previous ${target} version is available to roll back to`, {
			code: "update.no_previous_version",
		});
	}
}

/**
 * A server restart ends every stream, so a server install or rollback waits until none play, unless the
 * caller forces it. A web swap is live without a restart and is never held back.
 */
export function assertNoActiveStreams(state: UpdateInstallState, target: UpdateComponent, force: boolean): void {
	if (target !== "server" || force) return;

	const activeStreams = state.countActiveStreams();
	if (activeStreams > 0) {
		throw new DomainError("conflict", "A server update is blocked while streams are active", {
			code: "update.blocked_active_streams",
			params: { activeStreams },
		});
	}
}

async function assertNewerReleaseAvailable(state: UpdateInstallState, target: UpdateComponent): Promise<AdminUpdateRelease> {
	await updateCheckService.checkLatest(true);
	const checkState = updateCheckService.getState();
	const release = target === "server" ? checkState.serverLatest : checkState.webLatest;
	if (!release) {
		throw new DomainError("validation", `No ${target} release information is available — check for updates first`, {
			code: "update.no_release_info",
		});
	}

	if (target === "server") {
		if (!isNewerVersion(release.version, SERVER_VERSION)) {
			throw new DomainError("validation", `ReelVault server ${SERVER_VERSION} is already up to date`, { code: "update.up_to_date" });
		}
	} else {
		const webVersion = readInstalledWebVersion(state.root) ?? resolveWebVersion();
		if (!(webVersion && isNewerVersion(release.version, webVersion))) {
			throw new DomainError("validation", `The web UI ${webVersion ?? "(version unknown)"} is already up to date`, {
				code: "update.up_to_date",
			});
		}

		// The web release declares the oldest server it works with. The UI only warns;
		// this is the actual gate, so the API and dashboard cannot bypass it.
		if (release.minServerVersion && isNewerVersion(release.minServerVersion, SERVER_VERSION)) {
			throw new DomainError(
				"validation",
				`Web UI ${release.version} requires server ${release.minServerVersion} or newer (running ${SERVER_VERSION}) — update the server first`,
				{ code: "update.server_too_old" },
			);
		}
	}

	return release;
}
