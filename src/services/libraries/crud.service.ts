import { existsSync } from "node:fs";
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
import { metadataProviderSettingsService } from "@/plugins/capabilities/metadata-provider-settings.service";
import { librariesRepository } from "@/repositories/libraries.repository";
import { libraryProviderSettingsRepository } from "@/repositories/library-provider-settings.repository";
import { recordAuditSafe } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { deleteWithArtifacts } from "@/services/artifacts/delete-with-artifacts";
import { librariesLog } from "@/services/libraries/libraries.logger";
import { libraryWatcherService } from "@/services/libraries/watching/library-watcher.service";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body.cache";
import { runSafely } from "@/utils/safe-execute.utils";
import { ingestLibraryCache } from "@/workers/definitions/media/media-file-ingest/dependencies.utils";
import { LIBRARY_LIST_PATH_PREFIXES, normalizeMetadataLanguage } from "./shared.utils";

/**
 * A typo in a source path would otherwise create a library that silently
 * scans nothing — fail the request with the offending path instead.
 */
function assertPathsExist(paths: CreateLibraryPath[]): void {
	for (const item of paths) {
		const resolved = resolve(item.path.trim());
		if (!existsSync(resolved)) {
			throw new DomainError("validation", `Source path does not exist: ${resolved}`, { code: "library.path_not_found" });
		}
	}
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

export async function createLibrary<F extends string>(
	body: CreateLibrary,
	query?: FieldsQuery<F>,
	context?: AdminAuditContext,
): Promise<SelectFields<LibraryWithRelations, F>> {
	return await runSafely(librariesLog, "create", async () => {
		assertPathsExist(body.paths);
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

		if (body.providerPriorities) {
			// awaits: sequential — the overrides are read back only after they are written
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
		if (body.paths) assertPathsExist(body.paths);

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
		ingestLibraryCache.delete(libraryId);
		// Dynamic import keeps the catalog graph out of the library service's
		// module-load cycle; this path runs once per admin edit.
		const { invalidateLibraryLanguageCache } = await import("@/services/catalog/metadata/providers/library-metadata-language.resolver");
		invalidateLibraryLanguageCache(libraryId);

		if (body.providerPriorities) {
			// awaits: sequential — the overrides are read back only after they are written
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
		ingestLibraryCache.delete(libraryId);

		const cleanup = await librariesRepository.deleteWithDependents(libraryId);
		await deleteWithArtifacts({
			cleanup,
			resourceType: "library",
			resourceId: libraryId,
			before: library,
			invalidate: async () => {
				invalidateResponseBodiesForPathPrefixes(LIBRARY_LIST_PATH_PREFIXES);
				await libraryWatcherService.syncWatchers();
			},
			context,
			logger: librariesLog.logger,
		});

		return { success: true };
	});
}
