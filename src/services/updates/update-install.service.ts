import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import type { ArchiveFetcher } from "@/plugins/catalog/plugin-package/download.fetcher";
import { createLogger } from "@/utils/logger.utils";
import { cancelInstall, cleanupStaleArtifacts, startInstall, startRollback } from "./install/actions.service";
import { defaultRestartScheduler } from "./install/restart.scheduler";
import type { RestartScheduler, UpdateActionOptions, UpdateInstallState, UpdateJob } from "./install/shared.types";
import {
	detectFlavor,
	detectInstallType,
	isPreviousVersionPresent,
	resolveInstallRoot,
	type UpdateComponent,
	type UpdateFlavor,
	type UpdateInstallType,
} from "./update-environment.utils";

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

export class UpdateInstallService {
	readonly serviceName = "UpdateInstallService";
	readonly logger = createLogger("UpdateInstallService");

	private readonly state: UpdateInstallState;

	constructor(options: UpdateServiceOptions = {}) {
		const root = options.root ?? resolveInstallRoot();
		this.state = {
			serviceName: this.serviceName,
			logger: this.logger,
			root,
			installType: options.installType ?? detectInstallType(root),
			flavor: options.flavor ?? detectFlavor(root),
			restartScheduler: options.restartScheduler ?? defaultRestartScheduler(),
			archiveFetcher: options.archiveFetcher,
			countActiveStreams: options.countActiveStreams ?? (() => streamingManager.getAllActiveSessions().length),
			job: null,
			cancelController: null,
			lastServerError: null,
			lastWebError: null,
		};
	}

	getJob(): UpdateJob | null {
		return this.state.job;
	}

	getLastError(target: UpdateComponent): string | null {
		return target === "server" ? this.state.lastServerError : this.state.lastWebError;
	}

	getInstallType(): UpdateInstallType {
		return this.state.installType;
	}

	getFlavor(): UpdateFlavor {
		return this.state.flavor;
	}

	isRollbackAvailable(target: UpdateComponent): boolean {
		return this.state.installType === "archive" && isPreviousVersionPresent(target, this.state.root);
	}

	/** Removes scratch directories left behind by an interrupted update. */
	cleanupStaleArtifacts(): void {
		cleanupStaleArtifacts(this.state);
	}

	async startInstall(
		target: UpdateComponent,
		actorUserId: string | null = null,
		options: UpdateActionOptions = {},
	): Promise<{ started: boolean; target: UpdateComponent; version: string }> {
		return await startInstall(this.state, target, actorUserId, options);
	}

	startRollback(
		target: UpdateComponent,
		actorUserId: string | null = null,
		options: UpdateActionOptions = {},
	): { started: boolean; target: UpdateComponent; version: string } {
		return startRollback(this.state, target, actorUserId, options);
	}

	/**
	 * Stops an install that has not replaced any file yet. The download aborts at once; the
	 * extraction and checksum stages stop at their next checkpoint. A swap in progress always completes.
	 */
	cancelInstall(target: UpdateComponent): { target: UpdateComponent } {
		return cancelInstall(this.state, target);
	}
}

export const updateInstallService = new UpdateInstallService();
