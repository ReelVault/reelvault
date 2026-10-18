import type {
	FieldsConfig,
	FieldsQuery,
	LibraryFilters,
	LibrarySorting,
	LibraryWithRelations,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
} from "@reelvault/sdk/common";
import { and, eq, ne } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryFiltering } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { selectManyWithFields } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import { findPageWithQueryMap } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { parseFieldsForRead } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import type { ProjectedSelectParams } from "@/integrations/drizzle-orm/query/table-access/table-access.types";
import { loadRelations, toLibraryWithRelations } from "./relations.utils";
import { type LibraryStatsCaches, libraries } from "./shared.types";

const libraryQueryMap: QueryMap<LibraryFilters, LibrarySorting> = {
	filters: {
		name: (value: string) => QueryFiltering.like(schema.libraries.name, value),
		type: (value: string) => QueryFiltering.eq(schema.libraries.type, value),
	},
	orderBy: {
		name: schema.libraries.name,
		type: schema.libraries.type,
		createdAt: schema.libraries.createdAt,
		updatedAt: schema.libraries.updatedAt,
	},
	defaults: { sortBy: "name", sortOrder: "asc" },
};

export interface FindLibraryByIdParams<F extends string> {
	primaryId: string;
	fields?: FieldsConfig<F> | undefined;
	tx?: DatabaseTransaction | undefined;
}

export async function findActiveLibraryPaths(): Promise<Array<{ id: string; libraryId: string; path: string; isActive: boolean }>> {
	const client = databaseFactory.getClient();

	return await client
		.select({
			id: schema.libraryPaths.id,
			libraryId: schema.libraryPaths.libraryId,
			path: schema.libraryPaths.path,
			isActive: schema.libraryPaths.isActive,
		})
		.from(schema.libraryPaths)
		.where(eq(schema.libraryPaths.isActive, true));
}

/** Ids of every library, so scan-all can queue them. */
export async function findAllIds(): Promise<string[]> {
	const rows = await databaseFactory.getClient().select({ id: schema.libraries.id }).from(schema.libraries);

	return rows.map((row) => row.id);
}

export async function findWithPaths(
	caches: LibraryStatsCaches,
	libraryId: string,
	tx?: DatabaseTransaction,
): Promise<LibraryWithRelations | undefined> {
	return await findById<never>(caches, { primaryId: libraryId, tx });
}

export async function findPage<F extends string>(
	caches: LibraryStatsCaches,
	query?: PaginationQuery & FieldsQuery<F> & LibrarySorting & LibraryFilters,
): Promise<PaginatedResponse<SelectFields<LibraryWithRelations, F>>> {
	return await findPageWithQueryMap({
		access: libraries,
		queryMap: libraryQueryMap,
		query,
		findMany: (params) => findMany(caches, params),
	});
}

/**
 * Direct existence probe for the create/update conflict checks. Must NOT go
 * through `findPage` — its `total` rides the 10 s count cache, which hides
 * freshly created duplicates and lets a duplicate slip through as 200.
 */
export async function hasNameConflict(name: string, type: "movies" | "tv_shows", excludeLibraryId?: string): Promise<boolean> {
	const row = await libraries.selectFirst({
		where: excludeLibraryId
			? and(eq(schema.libraries.name, name), eq(schema.libraries.type, type), ne(schema.libraries.id, excludeLibraryId))
			: and(eq(schema.libraries.name, name), eq(schema.libraries.type, type)),
	});

	return row !== undefined;
}

export async function findByIdForRead<F extends string>(caches: LibraryStatsCaches, libraryId: string, query?: FieldsQuery<F>) {
	return await findById(caches, { primaryId: libraryId, fields: parseFieldsForRead(query) });
}

/** Get all libraries with pagination */
export async function findMany<F extends string>(
	caches: LibraryStatsCaches,
	{ fields, where, orderBy, limit, offset, tx }: ProjectedSelectParams<F>,
): Promise<Array<SelectFields<LibraryWithRelations, F>>> {
	const data = await selectManyWithFields(libraries, { fields, required: ["id"], where, orderBy, limit, offset, tx });
	const relations = await loadRelations(
		caches,
		data.map((library) => library.id),
		tx,
		fields,
	);

	return data.map((item) => toLibraryWithRelations(item, relations, fields));
}

/** Get a single library by ID */
export async function findById<F extends string>(
	caches: LibraryStatsCaches,
	{ primaryId, fields, tx }: FindLibraryByIdParams<F>,
): Promise<SelectFields<LibraryWithRelations, F> | undefined> {
	const library = await libraries.selectFirstById({ primaryId, tx });

	if (!library) return undefined;

	const relations = await loadRelations(caches, [library.id], tx, fields);

	return toLibraryWithRelations(library, relations, fields);
}
