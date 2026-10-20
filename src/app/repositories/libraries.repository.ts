import type {
	CreateLibrary,
	FieldsQuery,
	LibraryFilters,
	LibrarySorting,
	LibraryWithRelations,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	UpdateLibrary,
} from "@reelvault/sdk/common";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { defineRepository } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import type { ProjectedSelectParams } from "@/integrations/drizzle-orm/query/table-access/table-access.types";
import type { MediaCleanupData } from "@/integrations/drizzle-orm/utils/media-cleanup.reader";
import {
	type FindLibraryByIdParams,
	findActiveLibraryPaths,
	findAllIds,
	findById,
	findByIdForRead,
	findMany,
	findPage,
	findWithPaths,
	hasNameConflict,
} from "./libraries/reads.reader";
import { deleteWithDependents } from "./libraries/remove.writer";
import { clearStatsCaches, createLibraryStatsCaches, libraries, libraryPaths } from "./libraries/shared.types";
import {
	create,
	createAndRead,
	type LibraryCreateParams,
	type LibraryUpdateParams,
	update,
	updateAndRead,
} from "./libraries/writes.writer";

const caches = createLibraryStatsCaches();

const overrides = {
	deletePaths: libraryPaths.delete,

	clearStatsCache(): void {
		clearStatsCaches(caches);
	},

	async findActiveLibraryPaths(): Promise<Array<{ id: string; libraryId: string; path: string; isActive: boolean }>> {
		return await findActiveLibraryPaths();
	},

	/** Ids of every library, so scan-all can queue them. */
	async findAllIds(): Promise<string[]> {
		return await findAllIds();
	},

	async findWithPaths(libraryId: string, tx?: DatabaseTransaction): Promise<LibraryWithRelations | undefined> {
		return await findWithPaths(caches, libraryId, tx);
	},

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & LibrarySorting & LibraryFilters,
	): Promise<PaginatedResponse<SelectFields<LibraryWithRelations, F>>> {
		return await findPage(caches, query);
	},

	/**
	 * Direct existence probe for the create/update conflict checks. Must NOT go
	 * through `findPage` — its `total` rides the 10 s count cache, which hides
	 * freshly created duplicates and lets a duplicate slip through as 200.
	 */
	async hasNameConflict(name: string, type: "movies" | "tv_shows", excludeLibraryId?: string): Promise<boolean> {
		return await hasNameConflict(name, type, excludeLibraryId);
	},

	async createAndRead<F extends string>(body: CreateLibrary, query?: FieldsQuery<F>) {
		return await createAndRead(caches, body, query);
	},

	async findByIdForRead<F extends string>(libraryId: string, query?: FieldsQuery<F>) {
		return await findByIdForRead(caches, libraryId, query);
	},

	async updateAndRead<F extends string>(libraryId: string, body: UpdateLibrary, query?: FieldsQuery<F>) {
		return await updateAndRead(caches, libraryId, body, query);
	},

	async update(params: LibraryUpdateParams): Promise<void> {
		return await update(caches, params);
	},

	async deleteWithDependents(libraryId: string): Promise<MediaCleanupData> {
		return await deleteWithDependents(caches, libraryId);
	},

	/** Get all libraries with pagination */
	async findMany<F extends string>(params: ProjectedSelectParams<F>): Promise<Array<SelectFields<LibraryWithRelations, F>>> {
		return await findMany(caches, params);
	},

	/** Get a single library by ID */
	async findById<F extends string>(params: FindLibraryByIdParams<F>): Promise<SelectFields<LibraryWithRelations, F> | undefined> {
		return await findById(caches, params);
	},

	/**
	 * Create a new library. Returns undefined when a concurrent request won the
	 * race and the (name, type) row already exists — the service turns that
	 * into a 409 instead of pretending the caller created it.
	 */
	async create<F extends string>(params: LibraryCreateParams<F>): Promise<SelectFields<LibraryWithRelations, F> | undefined> {
		return await create(caches, params);
	},
};

export const librariesRepository = defineRepository(libraries, overrides);
