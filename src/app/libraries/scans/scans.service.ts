import type { LibraryScanProgress, LibraryScanProgressResponse } from "@reelvault/sdk/common";
import { recordUpdateAudit } from "@/app/admin/admin-audit.service";
import { getLibraryForScan } from "@/app/libraries/crud.service";
import type { LibrariesServiceState } from "@/app/libraries/shared.utils";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { librariesRepository } from "@/app/repositories/libraries.repository";
import { workerOperationRepository } from "@/app/repositories/worker-operation.repository";
import { assertFound } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { enqueueLibraryScan } from "@/workers/definitions/libraries/library-scan.worker";
import { enqueueDeduped } from "@/workers/utils/enqueue-deduped.utils";

interface ScanRequest {
	libraryId: string;
	paths: string[];
	pathId?: string;
}

async function triggerLibraryScan(state: LibrariesServiceState, data: ScanRequest, dedupeKey: string) {
	return await enqueueDeduped({
		targets: [{ workerId: "library-scan", dedupeKey }],
		type: "library-scanning",
		reference: { type: "library", id: data.libraryId },
		label: "library scan",
		enqueue: (operationId) => enqueueLibraryScan(data, { operationId }),
		onDeduped: (operationId) => queueCatchUpScan(state, data, dedupeKey, operationId),
	});
}

/**
 * A scan request that loses the dedupe race still needs a diff of the CURRENT
 * disk state — the running scan may have walked the disk before the new files
 * landed. Queue at most one catch-up scan under a separate dedupe key; the
 * per-library run lock makes it execute after the active scan. It attaches to
 * the same operation, so both passes show up together.
 */
async function queueCatchUpScan(state: LibrariesServiceState, data: ScanRequest, dedupeKey: string, operationId: string): Promise<void> {
	try {
		const { workerService } = await import("@/workers/worker.service");
		const catchUpKey = `${dedupeKey}:catch-up`;
		if (await workerService.findActiveItem("library-scan", catchUpKey)) return;

		await enqueueLibraryScan(data, { operationId }, catchUpKey);
		state.logger.info("Scan already running — queued a catch-up scan for the latest disk state", {
			libraryId: data.libraryId,
			dedupeKey,
		});
	} catch (error) {
		// A failed catch-up must not fail the original scan request.
		state.logger.warn("Could not queue a catch-up library scan", { libraryId: data.libraryId, error });
	}
}

export async function scanLibrary(state: LibrariesServiceState, libraryId: string, context?: AdminAuditContext) {
	return await runSafely(state, "scan", async () => {
		const library = await getLibraryForScan(libraryId, { fields: "id,paths.path" });

		const data = {
			libraryId: library.id,
			paths: library.paths.map((p) => p.path),
		};
		const result = await triggerLibraryScan(state, data, `${library.id}:all`);

		recordUpdateAudit(state.logger, {
			resourceType: "library_scan",
			resourceId: library.id,
			after: { operationId: result.operationId, paths: data.paths },
			context,
		});

		return result;
	});
}

/** Queues a scan of every library in order. The library-scan worker runs one scan at a time, so they run one after another. */
export async function scanAllLibraries(state: LibrariesServiceState, context?: AdminAuditContext) {
	return await runSafely(state, "scanAll", async () => {
		const libraryIds = await librariesRepository.findAllIds();
		const queued: Array<{ libraryId: string; operationId: string }> = [];
		for (const libraryId of libraryIds) {
			const result = await scanLibrary(state, libraryId, context);
			queued.push({ libraryId, operationId: result.operationId });
		}

		return { queued };
	});
}

/** Cancels the queued and running scans of a library: its whole-library scan, its path scans and their catch-up passes. */
export async function cancelLibraryScans(state: LibrariesServiceState, libraryId: string, context?: AdminAuditContext) {
	return await runSafely(state, "cancelScans", async () => {
		const library = await getLibraryForScan(libraryId, { fields: "id,paths.id" });
		const { workerService } = await import("@/workers/worker.service");

		const scanKeys = [`${library.id}:all`, ...library.paths.map((path) => `${library.id}:${path.id}`)];
		const dedupeKeys = scanKeys.flatMap((key) => [key, `${key}:catch-up`]);
		const active = await workerService.findActiveItems("library-scan", dedupeKeys);
		const operationIds = [...new Set(active.map((item) => item.operationId).filter((id): id is string => typeof id === "string"))];

		let cancelled = 0;
		for (const operationId of operationIds) {
			if (await workerService.cancelOperation(operationId)) cancelled++;
		}

		recordUpdateAudit(state.logger, {
			resourceType: "library_scan",
			resourceId: library.id,
			after: { cancelled, operationIds },
			context,
		});

		return { cancelled };
	});
}

export async function scanLibraryPath(state: LibrariesServiceState, libraryId: string, pathId: string, context?: AdminAuditContext) {
	return await runSafely(state, "scanPath", async () => {
		const library = await getLibraryForScan(libraryId, { fields: "id,paths.id,paths.path,paths.isActive" });

		const path = library.paths.find((item) => item.id === pathId && item.isActive);
		assertFound(path, "Library path", pathId);

		const result = await triggerLibraryScan(
			state,
			{ libraryId: library.id, paths: [path.path], pathId: path.id },
			`${library.id}:${path.id}`,
		);

		recordUpdateAudit(state.logger, {
			resourceType: "library_scan",
			resourceId: `${library.id}:${path.id}`,
			after: { operationId: result.operationId, pathId: path.id, path: path.path },
			context,
		});

		return result;
	});
}

/** Each library's queued or running scan. A running scan is reported in place of a queued one for the same library. */
export async function getScanProgress(state: LibrariesServiceState): Promise<LibraryScanProgressResponse> {
	return await runSafely(state, "getScanProgress", async () => {
		const byLibrary = new Map<string, LibraryScanProgress>();
		for (const scan of await workerOperationRepository.findActiveLibraryScans()) {
			const current = byLibrary.get(scan.libraryId);
			if (!current || (current.status === "pending" && scan.status === "running")) byLibrary.set(scan.libraryId, scan);
		}

		return { data: [...byLibrary.values()] };
	});
}
