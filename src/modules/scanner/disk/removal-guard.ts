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
		// A range file owns one row per episode, so the same path repeats in the
		// candidate list — stat each path once.
		const uniqueCandidates = [...new Set(candidates)];
		const states = new Map<string, "exists" | "missing" | "unavailable">();
		let storageUnavailable = false;
		await PromiseUtils.mapConcurrent(
			uniqueCandidates,
			this.dependencies.getIoConcurrency(),
			async (candidatePath) => {
				const state = await this.dependencies.existence(candidatePath);
				states.set(candidatePath, state);
				if (state === "exists") {
					this.logger.warn("Keeping media file — re-check found it on disk", { libraryId, path: candidatePath });
				}

				// A stat that failed for any reason other than "not found" (ACL, busy,
				// I/O, timeout) means the storage is unreliable, not that the file was
				// deleted. Never purge records on that basis.
				if (state === "unavailable") storageUnavailable = true;
			},
			signal,
		);
		throwIfAborted(signal);

		const removedFiles: string[] = [];
		const seenPaths = new Set<string>();
		let confirmedRows = 0;
		for (const candidatePath of candidates) {
			if (states.get(candidatePath) !== "missing") continue;

			// The mass-removal ratio is row-weighted (what the DB would purge);
			// the returned list is path-unique.
			confirmedRows++;
			if (!seenPaths.has(candidatePath)) {
				seenPaths.add(candidatePath);
				removedFiles.push(candidatePath);
			}
		}

		const massRemoval = isMassRemoval(existingCount, confirmedRows, filesOnDiskCount);

		return { removedFiles, storageUnavailable, massRemoval, skipRemovals: massRemoval || storageUnavailable };
	}
}

export const removalGuard = new RemovalGuard();
