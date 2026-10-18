import type { FieldsConfig, LibraryWithRelations, SelectFields } from "@reelvault/sdk/common";
import { inArray } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { buildMediaFileProjection } from "@/integrations/drizzle-orm/utils/media-file-projection.builder";
import { groupBy } from "@/utils/array.utils";
import type { EnrichedLibraryPath, LibraryRelations, LibraryStats, LibraryStatsCaches } from "./shared.types";
import { enrichPathsWithStats, loadLibraryStats } from "./stats.reader";

export async function loadRelations<F extends string>(
	caches: LibraryStatsCaches,
	libraryIds: string[],
	tx?: DatabaseTransaction,
	fields?: FieldsConfig<F>,
): Promise<LibraryRelations> {
	if (libraryIds.length === 0) {
		return { paths: new Map(), mediaFiles: new Map(), stats: new Map() };
	}

	const client = databaseFactory.getClient({ tx });
	const mediaFileProjection = fields?.relations.mediaFiles?.length
		? buildMediaFileProjection(fields.relations.mediaFiles, "libraryId")
		: undefined;
	const shouldLoadMediaFiles = Boolean(fields?.fields.length && QueryFields.includes(fields, "mediaFiles"));
	const shouldLoadPaths = !fields?.fields.length || QueryFields.includes(fields, "paths");
	// The aggregate is only needed when the caller reads library-level stats or
	// paths (single-path path stats reuse it). Narrow field reads like
	// `{fields:"id,type"}` must not pay for a COUNT+SUM over media_files.
	const shouldLoadStats =
		!fields?.fields.length ||
		shouldLoadPaths ||
		QueryFields.includes(fields, "totalMediaFiles") ||
		QueryFields.includes(fields, "totalSize");

	// Uncached ids are aggregated in one query and cached per key; concurrent
	// callers sharing a library id reuse a single in-flight load.
	let libraryStatsPromise: Promise<Map<string, LibraryStats>>;
	if (!shouldLoadStats) {
		libraryStatsPromise = Promise.resolve(new Map<string, LibraryStats>());
	} else if (tx) {
		libraryStatsPromise = loadLibraryStats(libraryIds, tx);
	} else {
		libraryStatsPromise = caches.libraryStatsCache.getOrSetMany(libraryIds, async (missing) => await loadLibraryStats(missing));
	}

	const pathsPromise = shouldLoadPaths
		? client.select().from(schema.libraryPaths).where(inArray(schema.libraryPaths.libraryId, libraryIds))
		: Promise.resolve([]);
	let mediaFilesPromise: PromiseLike<Array<typeof schema.mediaFiles.$inferSelect>>;
	if (!shouldLoadMediaFiles) {
		mediaFilesPromise = Promise.resolve([]);
	} else if (mediaFileProjection) {
		mediaFilesPromise = client.select(mediaFileProjection).from(schema.mediaFiles).where(inArray(schema.mediaFiles.libraryId, libraryIds));
	} else {
		mediaFilesPromise = client.select().from(schema.mediaFiles).where(inArray(schema.mediaFiles.libraryId, libraryIds));
	}

	const [rawPaths, mediaFiles, libraryStats] = await Promise.all([pathsPromise, mediaFilesPromise, libraryStatsPromise]);

	const enrichedPaths: Map<string, EnrichedLibraryPath[]> =
		shouldLoadPaths && rawPaths.length > 0
			? await enrichPathsWithStats(caches, libraryIds, rawPaths, libraryStats, tx)
			: new Map<string, EnrichedLibraryPath[]>();

	return {
		paths: enrichedPaths,
		mediaFiles: groupBy(mediaFiles, (file) => file.libraryId),
		stats: libraryStats,
	};
}

/** Builds the library DTO (relations applied) shared by `findMany` and `findById`. */
export function toLibraryWithRelations<F extends string>(
	item: typeof schema.libraries.$inferSelect,
	relations: LibraryRelations,
	fields?: FieldsConfig<F>,
): SelectFields<LibraryWithRelations, F> {
	const stats = relations.stats.get(item.id) ?? { totalMediaFiles: 0, totalSize: 0 };

	return QueryFields.apply<LibraryWithRelations, F>(
		{
			...item,
			totalMediaFiles: stats.totalMediaFiles,
			totalSize: stats.totalSize,
			mediaFileCount: stats.totalMediaFiles,
			paths: relations.paths.get(item.id) ?? [],
			mediaFiles: relations.mediaFiles.get(item.id) ?? [],
		},
		fields,
	);
}
