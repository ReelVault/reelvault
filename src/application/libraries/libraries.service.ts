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
import { libraryProviderSettingsRepository } from "@/database/repositories/library-provider-settings.repository";
import { type ScanFindingItem, scanFindingsRepository } from "@/database/repositories/scan-findings.repository";
import { metadataProviderSettingsService } from "@/plugins/capabilities/metadata-provider-settings.service";
import { BaseService } from "@/utils/base-service";
import { ConflictError, ValidationError } from "@/utils/errors";
import { LANGUAGE_TAG_PATTERN } from "@/utils/language.utils";
import { PathUtils } from "@/utils/path.utils";
import { invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body-cache";
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

/** Routes whose cached bodies list libraries — invalidated on library mutations. */
const LIBRARY_LIST_PATH_PREFIXES = ["/v1/libraries"] as const;

/**
 * Server-owned normalization for the per-library metadata language override:
 * `null`/empty clears it, otherwise an ISO language tag is required.
 * `undefined` (field absent) keeps the stored value untouched on updates.
 */
function normalizeMetadataLanguage(value: string | null | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;

	const trimmed = value.trim();
	if (!trimmed) return null;

	if (!LANGUAGE_TAG_PATTERN.test(trimmed)) {
		throw new ValidationError("metadataLanguage must be an ISO language code like 'pl' or 'en-US'", {
			code: "library.invalid_metadata_language",
		});
	}

	return trimmed;
}

class LibrariesService extends BaseService {
	constructor() {
		super("LibrariesService");
		// Break the libraries ↔ watcher import cycle: the watcher calls back here.
		libraryWatcherService.registerScanner((libraryId, pathId) => this.scanPath(libraryId, pathId));
		libraryWatcherService.registerLibraryScanner((libraryId) => this.scan(libraryId));
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
				const [{ data: siblings }, providerPriorities] = await Promise.all([
					librariesRepository.findPage({ limit: 50 }),
					libraryProviderSettingsRepository.listForLibrary(libraryId),
				]);

				return Object.assign(library, {
					siblings: siblings.filter((sibling) => sibling.id !== library.id),
					providerPriorities,
				});
			}

			return Object.assign(library, {
				providerPriorities: await libraryProviderSettingsRepository.listForLibrary(libraryId),
			});
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

			const metadataLanguage = normalizeMetadataLanguage(body.metadataLanguage);
			const library = await librariesRepository.createAndRead(metadataLanguage === undefined ? body : { ...body, metadataLanguage }, query);
			if (!library) {
				// Lost a race against a concurrent create with the same (name, type)
				// — the pre-check above only catches non-concurrent duplicates.
				throw new ConflictError(`A ${body.type} library named "${body.name}" already exists`, { code: "library.name_conflict" });
			}

			if (body.providerPriorities) {
				await metadataProviderSettingsService.setLibraryOverrides(library.id, body.providerPriorities);
				library.providerPriorities = await libraryProviderSettingsRepository.listForLibrary(library.id);
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

			invalidateResponseBodiesForPathPrefixes(LIBRARY_LIST_PATH_PREFIXES);
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

			const metadataLanguage = normalizeMetadataLanguage(body.metadataLanguage);
			const result = await librariesRepository.updateAndRead(
				libraryId,
				metadataLanguage === undefined ? body : { ...body, metadataLanguage },
				query,
			);
			this.assertExists(result, "Library", libraryId);
			ingestLibraryCache.delete(libraryId);
			// Dynamic import keeps the catalog graph out of the library service's
			// module-load cycle; this path runs once per admin edit.
			const { invalidateLibraryLanguageCache } = await import("@/application/catalog/metadata/metadata-process");
			invalidateLibraryLanguageCache(libraryId);

			if (body.providerPriorities) {
				await metadataProviderSettingsService.setLibraryOverrides(libraryId, body.providerPriorities);
				result.providerPriorities = await libraryProviderSettingsRepository.listForLibrary(libraryId);
			}

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

			invalidateResponseBodiesForPathPrefixes(LIBRARY_LIST_PATH_PREFIXES);
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

			invalidateResponseBodiesForPathPrefixes(LIBRARY_LIST_PATH_PREFIXES);
			await libraryWatcherService.syncWatchers();

			return { success: true };
		});
	}

	/**
	 * Existence-checked read for internal scan paths. `getById` also loads the
	 * provider-priority overrides, which none of these callers use.
	 */
	private async getLibraryForScan<F extends string>(libraryId: string, query: FieldsQuery<F>) {
		const library = await librariesRepository.findByIdForRead(libraryId, query);
		this.assertExists(library, "Library", libraryId);

		return library;
	}

	async scan(libraryId: string, context?: AdminAuditContext) {
		return await this.safeExecute("scan", async () => {
			const library = await this.getLibraryForScan(libraryId, { fields: "id,paths.path" });

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
			const library = await this.getLibraryForScan(libraryId, { fields: "id,paths.id,paths.path,paths.isActive" });

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
			await this.getLibraryForScan(libraryId, { fields: "id" });

			return await scanFindingsRepository.list(libraryId);
		});
	}

	async checkErrors(libraryPaths: string[], context?: AdminAuditContext) {
		return await this.safeExecute("checkErrors", async () => {
			const normalizedPaths = normalizeLibraryPaths(libraryPaths);
			if (normalizedPaths.length === 0) throw new ValidationError("At least one library path is required");

			const data: LibraryErrorsCheckData = { libraryPaths: normalizedPaths };
			const dedupeKey = createLibraryErrorsCheckDedupeKey(normalizedPaths);
			const enqueued = await enqueueDeduped({
				targets: [{ workerId: "library-errors-check", dedupeKey }],
				type: "library-errors-check",
				reference: { type: "library-errors", id: dedupeKey },
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

	private async triggerLibraryScan(data: { libraryId: string; paths: string[]; pathId?: string }, dedupeKey: string) {
		return await enqueueDeduped({
			targets: [{ workerId: "library-scan", dedupeKey }],
			type: "library-scanning",
			reference: { type: "library", id: data.libraryId },
			label: "library scan",
			enqueue: (operationId) => enqueueLibraryScan(data, { operationId }),
			onDeduped: (operationId) => this.queueCatchUpScan(data, dedupeKey, operationId),
		});
	}

	/**
	 * A scan request that loses the dedupe race still needs a diff of the CURRENT
	 * disk state — the running scan may have walked the disk before the new files
	 * landed. Queue at most one catch-up scan under a separate dedupe key; the
	 * per-library run lock makes it execute after the active scan. It attaches to
	 * the same operation, so both passes show up together.
	 */
	private async queueCatchUpScan(
		data: { libraryId: string; paths: string[]; pathId?: string },
		dedupeKey: string,
		operationId: string,
	): Promise<void> {
		try {
			const { workerService } = await import("@/workers/worker.service");
			const catchUpKey = `${dedupeKey}:catch-up`;
			if (await workerService.findActiveItem("library-scan", catchUpKey)) return;

			await enqueueLibraryScan(data, { operationId }, catchUpKey);
			this.logger.info("Scan already running — queued a catch-up scan for the latest disk state", {
				libraryId: data.libraryId,
				dedupeKey,
			});
		} catch (error) {
			// A failed catch-up must not fail the original scan request.
			this.logger.warn("Could not queue a catch-up library scan", { libraryId: data.libraryId, error });
		}
	}
}

export const librariesService = new LibrariesService();
