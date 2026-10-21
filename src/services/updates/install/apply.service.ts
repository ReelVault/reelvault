import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_VERSION } from "@/config/version.constants";
import { extractArchive } from "@/plugins/catalog/plugin-package/extract.extractor";
import { PENDING_DIR, readInstalledWebVersion, STAGING_DIR } from "@/services/updates/update-environment.utils";
import { swapIntoPlace, swapWebDirectory } from "@/services/updates/update-swap.utils";
import { GIB } from "@/utils/bytes.utils";
import { removeTreeSync } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { isRecord } from "@/utils/type.utils";
import { assertNotCancelled, setJob, type UpdateInstallState } from "./shared.types";

const MAX_UNCOMPRESSED_BYTES = 2 * GIB;

/**
 * The web dist is static — swapping the directory makes it live immediately
 * (index.html is served no-cache and re-read on change), no restart needed.
 */
export async function applyWebUpdate(state: UpdateInstallState, archivePath: string, version: string): Promise<void> {
	const stagingRoot = join(state.root, STAGING_DIR);
	setJob(state, "extracting", 75, null);
	resetDirectory(stagingRoot);
	// The web zip carries the dist contents at its root — the extraction
	// directory itself becomes the new `web/`.
	await extractArchive(archivePath, stagingRoot, MAX_UNCOMPRESSED_BYTES);
	if (!existsSync(join(stagingRoot, "index.html"))) {
		throw new DomainError("validation", "The extracted web release has an unexpected layout", { code: "update.unexpected_layout" });
	}

	assertNotCancelled(state);
	setJob(state, "swapping", 90, null);
	const replacedWebVersion = readInstalledWebVersion(state.root) ?? "";
	swapWebDirectory(state.root, stagingRoot, replacedWebVersion);

	state.job = null;
	state.logger.info(`Web UI updated to ${version} — live without a restart`, { previousVersion: replacedWebVersion });
}

export async function applyServerUpdate(state: UpdateInstallState, archivePath: string, version: string): Promise<void> {
	if (process.platform === "win32") {
		// Running executables lock their files: extract now, swap after exit.
		const pendingRoot = join(state.root, PENDING_DIR);
		assertNotCancelled(state);
		setJob(state, "swapping", 85, null);
		resetDirectory(pendingRoot);
		await extractArchive(archivePath, pendingRoot, MAX_UNCOMPRESSED_BYTES);
		assertServerStagedLayout(join(pendingRoot, "ReelVault"));

		setJob(state, "restarting", 97, null);
		state.restartScheduler.scheduleRestart(state.root);
	} else {
		const stagingRoot = join(state.root, STAGING_DIR);
		setJob(state, "extracting", 75, null);
		resetDirectory(stagingRoot);
		await extractArchive(archivePath, stagingRoot, MAX_UNCOMPRESSED_BYTES);
		const stagedApp = join(stagingRoot, "ReelVault");
		assertServerStagedLayout(stagedApp);

		assertNotCancelled(state);
		setJob(state, "swapping", 90, null);
		swapIntoPlace(state.root, stagedApp, "server", installedServerVersion(state));
		// The staging root now holds only the emptied ReelVault directory.
		removeTreeSync(stagingRoot);

		setJob(state, "restarting", 97, null);
		state.restartScheduler.scheduleRestart(state.root);
	}

	state.logger.info(`Server updated to ${version} — restarting`);
}

/** Server archives keep the classic `ReelVault/` layout minus `web/`. */
export function assertServerStagedLayout(stagedApp: string): void {
	if (!existsSync(join(stagedApp, "server", "package.json"))) {
		throw new DomainError("validation", "The extracted release archive has an unexpected layout", { code: "update.unexpected_layout" });
	}
}

/**
 * The version of the installed server layout, read from its package.json —
 * the rollback marker must describe what is being replaced, not the running
 * process (which normally matches, but the layout is the source of truth).
 */
export function installedServerVersion(state: UpdateInstallState): string {
	try {
		const manifest: unknown = JSON.parse(readFileSync(join(state.root, "server", "package.json"), "utf8"));
		if (isRecord(manifest) && typeof manifest.version === "string" && manifest.version.length > 0) return manifest.version;
	} catch {
		// Missing/unreadable layout — fall back to the running version below.
	}

	return SERVER_VERSION;
}

function resetDirectory(path: string): void {
	removeTreeSync(path);
	mkdirSync(path, { recursive: true });
}
