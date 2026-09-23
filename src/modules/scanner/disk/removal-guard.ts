import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { FileUtils } from "@/utils/file.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { isMassRemoval } from "../utils/scanner.utils";

export interface RemovalAssessment {
	/** Paths confirmed gone from disk — safe to purge from the database. */
	removedFiles: string[];
	/** At least one candidate could not be stat'ed; storage is unreliable. */
	storageUnavailable: boolean;
	/** The scan saw drastically fewer files than the database — likely a dead mount. */
	massRemoval: boolean;
	/** Convenience union: removals must be skipped entirely. */
	skipRemovals: boolean;
}

export interface RemovalAssessmentInput {
	libraryId: string;
	candidates: string[];
	existingCount: number;
	filesOnDiskCount: number;
	signal?: AbortSignal | undefined;
}

interface ServiceDependencies {
	existence: (path: string) => Promise<"exists" | "missing" | "unavailable">;
	getIoConcurrency: () => number;
}

const defaultDependencies: ServiceDependencies = {
	existence: (path) => FileUtils.existence(path),
	getIoConcurrency: () => systemResourcesService.getIoConcurrency(),
};

/**
 * Decides which removal candidates may actually be purged. A transient
 * stat/glob miss must not delete a file that is still on disk, and a whole
 * unmounted tree must never cascade-delete watched history and markers.
 */
export class RemovalGuard extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("RemovalGuard");
		this.dependencies = dependencies;
	}

	async assess({ libraryId, candidates, existingCount, filesOnDiskCount, signal }: RemovalAssessmentInput): Promise<RemovalAssessment> {
		const removedFiles: string[] = [];
		let storageUnavailable = false;
		await PromiseUtils.mapConcurrent(
			candidates,
			this.dependencies.getIoConcurrency(),
			async (candidatePath) => {
				const state = await this.dependencies.existence(candidatePath);
				if (state === "exists") {
					this.logger.warn("Keeping media file — re-check found it on disk", { libraryId, path: candidatePath });

					return;
				}

				// A stat that failed for any reason other than "not found" (ACL, busy,
				// I/O, timeout) means the storage is unreliable, not that the file was
				// deleted. Never purge records on that basis.
				if (state === "unavailable") {
					storageUnavailable = true;

					return;
				}

				removedFiles.push(candidatePath);
			},
			signal,
		);
		throwIfAborted(signal);

		const massRemoval = isMassRemoval(existingCount, removedFiles.length, filesOnDiskCount);

		return { removedFiles, storageUnavailable, massRemoval, skipRemovals: massRemoval || storageUnavailable };
	}
}

export const removalGuard = new RemovalGuard();
