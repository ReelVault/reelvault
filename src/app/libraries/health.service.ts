import type {
	LibraryErrorsCheckResult,
	LibraryErrorsCheckStatus,
	LibraryHealth,
	LibraryHealthResponse,
	LibraryPathHealth,
} from "@reelvault/sdk/common";
import { LibraryErrorsCheckResultSchema } from "@reelvault/sdk/common";
import { recordAuditSafe } from "@/app/admin/admin-audit.service";
import { libraryWatcherService } from "@/app/libraries/watching/library-watcher.service";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { librariesRepository } from "@/app/repositories/libraries.repository";
import { readCompletedOperationResult } from "@/app/repositories/worker-jobs/result.reader";
import { workerOperationRepository } from "@/app/repositories/worker-operation.repository";
import { systemResourcesService } from "@/config/system-resources.service";
import { toMap } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { mapConcurrent } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import {
	createLibraryErrorsCheckDedupeKey,
	enqueueLibraryErrorsCheck,
	type LibraryErrorsCheckData,
	normalizeLibraryPaths,
} from "@/workers/definitions/libraries/library-errors-check.worker";
import { enqueueDeduped } from "@/workers/utils/enqueue-deduped.utils";
import { describePath, type LibrariesServiceState } from "./shared.utils";

/** Most libraries one health report covers; the admin libraries page lists libraries on one page anyway. */
const MAX_HEALTH_LIBRARIES = 200;

type UnwatchableCode = "library.path_missing" | "library.watcher_error" | "library.watch_failed";

/**
 * The watcher's failure reason as a stable code. The reason keeps the exception text for the server log, so the text
 * itself is never returned to a client.
 */
function unwatchableCodeOf(reason: string): UnwatchableCode {
	if (reason === "path_missing") return "library.path_missing";
	if (reason.startsWith("watcher_error")) return "library.watcher_error";

	return "library.watch_failed";
}

export async function checkLibraryErrors(state: LibrariesServiceState, libraryPaths: string[], context?: AdminAuditContext) {
	return await runSafely(state, "checkErrors", async () => {
		const normalizedPaths = normalizeLibraryPaths(libraryPaths);
		if (normalizedPaths.length === 0)
			throw new DomainError("validation", "At least one library path is required", { code: "library.path_required" });

		const data: LibraryErrorsCheckData = { libraryPaths: normalizedPaths };
		const dedupeKey = createLibraryErrorsCheckDedupeKey(normalizedPaths);
		const enqueued = await enqueueDeduped({
			targets: [{ workerId: "library-errors-check", dedupeKey }],
			type: "library-errors-check",
			reference: { type: "library-errors", id: dedupeKey },
			label: "library error check",
			enqueue: (operationId) => enqueueLibraryErrorsCheck(data, { operationId }),
			onDeduped: () => state.logger.info("Library error check is already running — the request was folded into it", { dedupeKey }),
		});

		recordAuditSafe(
			{
				action: "create",
				resourceType: "library_errors_check",
				resourceId: enqueued.operationId,
				after: { operationId: enqueued.operationId, libraryPaths: normalizedPaths },
				context,
			},
			state.logger,
		);

		return enqueued;
	});
}

/** Status of a check queued by `checkErrors`; the result is read from the finished job once the check has completed. */
export async function getLibraryErrorsCheckStatus(state: LibrariesServiceState, operationId: string): Promise<LibraryErrorsCheckStatus> {
	return await runSafely(state, "getErrorsCheckStatus", async () => {
		const { workerService } = await import("@/workers/worker.service");
		const operation = await workerService.getOperation(operationId);
		if (operation?.type !== "library-errors-check") {
			throw new DomainError("not_found", "Error check operation not found", { code: "library.errors_check_not_found" });
		}

		let result: LibraryErrorsCheckResult | null = null;
		if (operation.status === "completed") {
			result = await readCompletedOperationResult(operationId, LibraryErrorsCheckResultSchema);
		}

		return { status: operation.status, progressPercent: operation.progressPercent, result };
	});
}

/** Every library's paths as they are now: whether each exists, whether the watcher covers it, and when the library was last scanned. */
export async function getLibraryHealth(state: LibrariesServiceState): Promise<LibraryHealthResponse> {
	return await runSafely(state, "getHealth", async () => {
		const { data: libraries } = await librariesRepository.findPage({ limit: MAX_HEALTH_LIBRARIES });
		const unwatchable = toMap(libraryWatcherService.getUnwatchablePaths(), (failure) => failure.pathId);
		const lastScans = await workerOperationRepository.findLatestLibraryScanTimes(libraries.map((library) => library.id));

		// The path stats are independent, so they run side by side: a server with
		// many library paths stat-ed them one after another, and a stat on a NAS
		// can take a while.
		const allPaths = libraries.flatMap((library) => library.paths.map((libraryPath) => ({ libraryId: library.id, libraryPath })));
		const pathStats = await mapConcurrent(allPaths, systemResourcesService.getIoConcurrency(), async (entry) => ({
			...entry,
			...(await describePath(entry.libraryPath.path)),
		}));
		const statsByPathId = toMap(pathStats, (entry) => entry.libraryPath.id);

		const data: LibraryHealth[] = [];
		for (const library of libraries) {
			const paths: LibraryPathHealth[] = [];
			for (const libraryPath of library.paths) {
				const stat = statsByPathId.get(libraryPath.id);
				const failure = unwatchable.get(libraryPath.id);
				let failureMeta: { unwatchableCode?: UnwatchableCode; unwatchableSince?: string } = {};
				if (failure) {
					failureMeta = {
						unwatchableCode: unwatchableCodeOf(failure.reason),
						unwatchableSince: new Date(failure.since).toISOString(),
					};
				}
				paths.push({
					pathId: libraryPath.id,
					path: libraryPath.path,
					exists: stat?.exists ?? false,
					isDirectory: stat?.isDirectory ?? false,
					watchStatus: failure ? "unwatchable" : "watching",
					...failureMeta,
				});
			}

			data.push({ libraryId: library.id, lastScanAt: lastScans.get(library.id)?.toISOString() ?? null, paths });
		}

		return { data };
	});
}
