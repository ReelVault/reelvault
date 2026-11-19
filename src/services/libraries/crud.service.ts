import { resolve } from "node:path";
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
import { systemResourcesService } from "@/config/system-resources.service";
import { metadataProviderSettingsService } from "@/plugins/capabilities/metadata-provider-settings.service";
import { librariesRepository } from "@/repositories/libraries.repository";
import { libraryProviderSettingsRepository } from "@/repositories/library-provider-settings.repository";
import { recordAuditSafe } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { deleteWithArtifacts } from "@/services/artifacts/delete-with-artifacts";
import { invalidateIngestLibrary } from "@/services/libraries/ingest-library.cache";
import { librariesLog } from "@/services/libraries/libraries.logger";
import { libraryWatcherService } from "@/services/libraries/watching/library-watcher.service";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { checkFileExistence } from "@/utils/file.utils";
import { mapConcurrent } from "@/utils/promise.utils";
import { invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body.cache";
import { runSafely } from "@/utils/safe-execute.utils";
import { LIBRARY_LIST_PATH_PREFIXES, normalizeMetadataLanguage } from "./shared.utils";

/**
 * A typo in a source path would otherwise create a library that silently
 * scans nothing — fail the request with the offending path instead.
 *
 * Async and deadline-bounded: `existsSync` on an unreachable network mount
 * blocked the whole event loop, and a path whose storage does not answer is
 * reported separately from a path that is genuinely missing.
 */
async function assertPathsExist(paths: CreateLibraryPath[]): Promise<void> {
	await mapConcurrent(paths, systemResourcesService.getIoConcurrency(), async (item) => {
		const resolved = resolve(item.path.trim());
		const state = await checkFileExistence(resolved);

		if (state === "missing") {
			throw new DomainError("validation", `Source path does not exist: ${resolved}`, { code: "library.path_not_found" });
		}

		if (state === "unavailable") {
			throw new DomainError("timeout", `Source path is not reachable: ${resolved}`, { code: "library.path_unavailable" });
		}
	});
}

/** Existence-checked read for internal scan paths. Skips the provider-priority overrides that only the detail view needs. */
export async function getLibraryForScan<F extends string>(libraryId: string, query: FieldsQuery<F>) {
	const library = await librariesRepository.findByIdForRead(libraryId, query);
	assertFound(library, "Library", libraryId);

	return library;
}

export async function getAllLibraries<F extends string>(
	query?: PaginationQuery & FieldsQuery<F> & LibrarySorting & LibraryFilters,
): Promise<PaginatedResponse<SelectFields<LibraryWithRelations, F>>> {
	return await runSafely(librariesLog, "getAll", async () => await librariesRepository.findPage(query));
}

export async function getLibraryById<F extends string>(libraryId: string, query?: FieldsQuery<F>, options?: { siblings?: boolean }) {
	return await runSafely(librariesLog, "getById", async () => {
		const library = await librariesRepository.findByIdForRead(libraryId, query);
		assertFound(library, "Library", libraryId);

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

/** Writes a library's provider priority overrides and returns the list as stored. */
async function writeProviderPriorities(
	libraryId: string,
	priorities: Parameters<typeof metadataProviderSettingsService.setLibraryOverrides>[1],
): Promise<Awaited<ReturnType<typeof libraryProviderSettingsRepository.listForLibrary>>> {
	await metadataProviderSettingsService.setLibraryOverrides(libraryId, priorities);

	return await libraryProviderSettingsRepository.listForLibrary(libraryId);
}

/** Drops the per-library caches a library's own row feeds: its ingest settings and its metadata-language override. */
async function forgetLibraryCaches(libraryId: string): Promise<void> {
	invalidateIngestLibrary(libraryId);
	// Dynamic import keeps the catalog graph out of the library service's module-load cycle.
	const { invalidateLibraryLanguageCache } = await import("@/services/catalog/metadata/providers/library-metadata-language.resolver");
	invalidateLibraryLanguageCache(libraryId);
}

export async function createLibrary<F extends string>(
	body: CreateLibrary,
	query?: FieldsQuery<F>,
	context?: AdminAuditContext,
): Promise<SelectFields<LibraryWithRelations, F>> {
	return await runSafely(librariesLog, "create", async () => {
		await assertPathsExist(body.paths);
		// Direct probe (not findPage) — the count cache would hide a library
		// created seconds ago and the duplicate would slip through as 200.
		if (await librariesRepository.hasNameConflict(body.name, body.type)) {
			throw new DomainError("conflict", `A ${body.type} library named "${body.name}" already exists`, { code: "library.name_conflict" });
		}

		const metadataLanguage = normalizeMetadataLanguage(body.metadataLanguage);
		const library = await librariesRepository.createAndRead(metadataLanguage === undefined ? body : { ...body, metadataLanguage }, query);
		if (!library) {
			// Lost a race against a concurrent create with the same (name, type)
			// — the pre-check above only catches non-concurrent duplicates.
			throw new DomainError("conflict", `A ${body.type} library named "${body.name}" already exists`, { code: "library.name_conflict" });
		}

		if (body.providerPriorities) library.providerPriorities = await writeProviderPriorities(library.id, body.providerPriorities);

		recordAuditSafe(
			{
				action: "create",
				resourceType: "library",
				resourceId: library.id,
				after: library,
				context,
			},
			librariesLog.logger,
		);

		invalidateResponseBodiesForPathPrefixes(LIBRARY_LIST_PATH_PREFIXES);
		await libraryWatcherService.syncWatchers();

		return library;
	});
}

export async function updateLibrary<F extends string>(
	libraryId: string,
	body: UpdateLibrary,
	query?: FieldsQuery<F>,
	context?: AdminAuditContext,
): Promise<SelectFields<LibraryWithRelations, F>> {
	return await runSafely(librariesLog, "update", async () => {
		if (body.paths) await assertPathsExist(body.paths);

		const before = await librariesRepository.findWithPaths(libraryId);
		assertFound(before, "Library", libraryId);
		// Renaming onto an existing (name, type) would otherwise die on the
		// unique index as a raw 500.
		if (body.name && (await librariesRepository.hasNameConflict(body.name, body.type ?? before.type, libraryId))) {
			throw new DomainError("conflict", `A ${body.type ?? before.type} library named "${body.name}" already exists`, {
				code: "library.name_conflict",
			});
		}

		const metadataLanguage = normalizeMetadataLanguage(body.metadataLanguage);
		const result = await librariesRepository.updateAndRead(
			libraryId,
			metadataLanguage === undefined ? body : { ...body, metadataLanguage },
			query,
		);
		assertFound(result, "Library", libraryId);
		await forgetLibraryCaches(libraryId);

		if (body.providerPriorities) result.providerPriorities = await writeProviderPriorities(libraryId, body.providerPriorities);

		recordAuditSafe(
			{
				action: "update",
				resourceType: "library",
				resourceId: libraryId,
				before,
				after: result,
				context,
			},
			librariesLog.logger,
		);

		invalidateResponseBodiesForPathPrefixes(LIBRARY_LIST_PATH_PREFIXES);
		await libraryWatcherService.syncWatchers();

		return result;
	});
}

export async function deleteLibrary(libraryId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
	return await runSafely(librariesLog, "delete", async () => {
		const library = await librariesRepository.findWithPaths(libraryId);
		assertFound(library, "Library", libraryId);

		const cleanup = await librariesRepository.deleteWithDependents(libraryId);
		await deleteWithArtifacts({
			cleanup,
			resourceType: "library",
			resourceId: libraryId,
			before: library,
			invalidate: async () => {
				await forgetLibraryCaches(libraryId);
				invalidateResponseBodiesForPathPrefixes(LIBRARY_LIST_PATH_PREFIXES);
				await libraryWatcherService.syncWatchers();
			},
			context,
			logger: librariesLog.logger,
		});

		return { success: true };
	});
}
