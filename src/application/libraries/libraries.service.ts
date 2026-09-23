import { existsSync } from "node:fs";
import type {
	CreateLibrary,
	CreateLibraryPath,
	FieldsQuery,
	LibraryFilters,
	LibrarySorting,
	LibraryWithRelations,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	UpdateLibrary,
} from "@reelvault/sdk/common";
import { recordAuditSafe } from "@/application/admin/admin-audit.service";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { type ScanFindingItem, scanFindingsRepository } from "@/database/repositories/scan-findings.repository";
import { BaseService } from "@/utils/base-service";
import { ConflictError, ValidationError } from "@/utils/errors";
import { PathUtils } from "@/utils/path.utils";
import { runMediaCleanup } from "@/utils/server-data.utils";
import {
	createLibraryErrorsCheckDedupeKey,
	enqueueLibraryErrorsCheck,
	type LibraryErrorsCheckData,
	normalizeLibraryPaths,
} from "@/workers/definitions/libraries/library-errors-check.worker";
import { enqueueLibraryScan } from "@/workers/definitions/libraries/library-scan.worker";
import { ingestLibraryCache } from "@/workers/definitions/media/media-file-ingest.worker";
import { enqueueDeduped } from "@/workers/utils/enqueue-deduped";
import { libraryWatcherService } from "./watching/library-watcher.service";

class LibrariesService extends BaseService {
	constructor() {
		super("LibrariesService");
		// Break the libraries ↔ watcher import cycle: the watcher calls back here.
		libraryWatcherService.registerScanner((libraryId, pathId) => this.scanPath(libraryId, pathId));
	}

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & LibrarySorting & LibraryFilters,
	): Promise<PaginatedResponse<SelectFields<LibraryWithRelations, F>>> {
		return await this.safeExecute("getAll", async () => await librariesRepository.findPage(query));
	}

	async getById<F extends string>(libraryId: string, query?: FieldsQuery<F>, options?: { siblings?: boolean }) {
		return await this.safeExecute("getById", async () => {
			const library = await librariesRepository.findByIdForRead(libraryId, query);
			this.assertExists(library, "Library", libraryId);

			if (options?.siblings) {
				const { data: siblings } = await librariesRepository.findPage({ limit: 50 });

				return Object.assign(library, {
					siblings: siblings.filter((sibling) => sibling.id !== library.id),
				});
			}

			return library;
		});
	}

	async create<F extends string>(
		body: CreateLibrary,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<LibraryWithRelations, F>> {
		return await this.safeExecute("create", async () => {
			this.assertPathsExist(body.paths);
			// Direct probe (not findPage) — the count cache would hide a library
			// created seconds ago and the duplicate would slip through as 200.
			if (await librariesRepository.hasNameConflict(body.name, body.type)) {
				throw new ConflictError(`A ${body.type} library named "${body.name}" already exists`, { code: "library.name_conflict" });
			}

			const library = await librariesRepository.createAndRead(body, query);
			if (!library) {
				// Lost a race against a concurrent create with the same (name, type)
				// — the pre-check above only catches non-concurrent duplicates.
				throw new ConflictError(`A ${body.type} library named "${body.name}" already exists`, { code: "library.name_conflict" });
			}

			recordAuditSafe(
				{
					action: "create",
					resourceType: "library",
					resourceId: library.id,
					after: library,
					context,
				},
				this.logger,
			);

			await libraryWatcherService.syncWatchers();

			return library;
		});
	}

	async update<F extends string>(
		libraryId: string,
		body: UpdateLibrary,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<LibraryWithRelations, F>> {
		return await this.safeExecute("update", async () => {
			if (body.paths) this.assertPathsExist(body.paths);

			const before = await librariesRepository.findWithPaths(libraryId);
			this.assertExists(before, "Library", libraryId);
			// Renaming onto an existing (name, type) would otherwise die on the
			// unique index as a raw 500.
			if (body.name && (await librariesRepository.hasNameConflict(body.name, body.type ?? before.type, libraryId))) {
				throw new ConflictError(`A ${body.type ?? before.type} library named "${body.name}" already exists`, {
					code: "library.name_conflict",
				});
			}

			const result = await librariesRepository.updateAndRead(libraryId, body, query);
			this.assertExists(result, "Library", libraryId);
			ingestLibraryCache.delete(libraryId);

			recordAuditSafe(
				{
					action: "update",
					resourceType: "library",
					resourceId: libraryId,
					before,
					after: result,
					context,
				},
				this.logger,
			);

			await libraryWatcherService.syncWatchers();

			return result;
		});
	}

	/**
	 * A typo in a source path would otherwise create a library that silently
	 * scans nothing — fail the request with the offending path instead.
	 */
	private assertPathsExist(paths: CreateLibraryPath[]): void {
		for (const item of paths) {
			const resolved = PathUtils.resolve(item.path.trim());
			if (!existsSync(resolved)) {
				throw new ValidationError(`Source path does not exist: ${resolved}`, { code: "library.path_not_found" });
			}
		}
	}

	async delete(libraryId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
		return await this.safeExecute("delete", async () => {
			const library = await librariesRepository.findWithPaths(libraryId);
			this.assertExists(library, "Library", libraryId);
			ingestLibraryCache.delete(libraryId);

			const cleanup = await librariesRepository.deleteWithDependents(libraryId);
			await runMediaCleanup(cleanup);

			recordAuditSafe(
				{
					action: "delete",
					resourceType: "library",
					resourceId: libraryId,
					before: library,
					context,
				},
				this.logger,
			);

			await libraryWatcherService.syncWatchers();

			return { success: true };
		});
	}

	async scan(libraryId: string, context?: AdminAuditContext) {
		return await this.safeExecute("scan", async () => {
			const library = await this.getById(libraryId, { fields: "id,paths.path" });
			this.assertExists(library, "Library", libraryId);

			const data = {
				libraryId: library.id,
				paths: library.paths.map((p) => p.path),
			};
			const result = await this.triggerLibraryScan(data, `${library.id}:all`);

			recordAuditSafe(
				{
					action: "update",
					resourceType: "library_scan",
					resourceId: library.id,
					after: { operationId: result.operationId, paths: data.paths },
					context,
				},
				this.logger,
			);

			return result;
		});
	}

	async scanPath(libraryId: string, pathId: string, context?: AdminAuditContext) {
		return await this.safeExecute("scanPath", async () => {
			const library = await this.getById(libraryId, { fields: "id,paths.id,paths.path,paths.isActive" });
			this.assertExists(library, "Library", libraryId);

			const path = library.paths.find((item) => item.id === pathId && item.isActive);
			this.assertExists(path, "Library path", pathId);

			const result = await this.triggerLibraryScan(
				{ libraryId: library.id, paths: [path.path], pathId: path.id },
				`${library.id}:${path.id}`,
			);

			recordAuditSafe(
				{
					action: "update",
					resourceType: "library_scan",
					resourceId: `${library.id}:${path.id}`,
					after: { operationId: result.operationId, pathId: path.id, path: path.path },
					context,
				},
				this.logger,
			);

			return result;
		});
	}

	async getScanFindings(libraryId: string): Promise<ScanFindingItem[]> {
		return await this.safeExecute("getScanFindings", async () => {
			const library = await this.getById(libraryId, { fields: "id" });
			this.assertExists(library, "Library", libraryId);

			return await scanFindingsRepository.list(libraryId);
		});
	}

	async checkErrors(libraryPaths: string[], context?: AdminAuditContext) {
		return await this.safeExecute("checkErrors", async () => {
			const normalizedPaths = normalizeLibraryPaths(libraryPaths);
			if (normalizedPaths.length === 0) throw new ValidationError("At least one library path is required");

			const data: LibraryErrorsCheckData = { libraryPaths: normalizedPaths };
			const enqueued = await enqueueDeduped({
				targets: [{ workerId: "library-errors-check", dedupeKey: createLibraryErrorsCheckDedupeKey(normalizedPaths) }],
				type: "library-errors-check",
				reference: { type: "library-errors", id: createLibraryErrorsCheckDedupeKey(normalizedPaths) },
				label: "library error check",
				enqueue: (operationId) => enqueueLibraryErrorsCheck(data, { operationId }),
			});

			recordAuditSafe(
				{
					action: "create",
					resourceType: "library_errors_check",
					resourceId: enqueued.operationId,
					after: { operationId: enqueued.operationId, libraryPaths: normalizedPaths },
					context,
				},
				this.logger,
			);

			return enqueued;
		});
	}

	private triggerLibraryScan(data: { libraryId: string; paths: string[]; pathId?: string }, dedupeKey: string) {
		return enqueueDeduped({
			targets: [{ workerId: "library-scan", dedupeKey }],
			type: "library-scanning",
			reference: { type: "library", id: data.libraryId },
			label: "library scan",
			enqueue: (operationId) => enqueueLibraryScan(data, { operationId }),
		});
	}
}

export const librariesService = new LibrariesService();
