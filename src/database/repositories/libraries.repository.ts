import type {
	CreateLibrary,
	CreateLibraryPath,
	FieldsConfig,
	FieldsQuery,
	LibraryFilters,
	LibrarySorting,
	LibraryWithRelations,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	UpdateLibrary,
} from "@reelvault/sdk/common";
import { and, eq, inArray, ne, notExists, notInArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { defineTableAccess, findPageWithQueryMap, forEachChunked, type ProjectedSelectParams } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import { buildMediaFileProjection } from "@/database/utils/media-file-projection";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";
import { createLocalStableKey } from "@/database/utils/stable-key";
import { MINUTE } from "@/server.constants";
import { groupBy, hasEntry, toMap } from "@/utils/array.utils";
import { ConflictError } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";
import { PathUtils } from "@/utils/path.utils";

const libraries = defineTableAccess("libraries", {
	primaryKeyColumn: "id",
});
const libraryPaths = defineTableAccess("libraryPaths", {
	primaryKeyColumn: "id",
});

interface LibraryStats {
	totalMediaFiles: number;
	totalSize: number;
}
interface LibraryPathStats {
	fileCount: number;
	totalSize: number;
}
interface LibraryRelations {
	paths: Map<string, EnrichedLibraryPath[]>;
	mediaFiles: Map<string, Array<typeof schema.mediaFiles.$inferSelect>>;
	stats: Map<string, LibraryStats>;
}
type EnrichedLibraryPath = typeof schema.libraryPaths.$inferSelect & LibraryPathStats & { size: number };

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

class LibrariesRepository {
	readonly table = schema.libraries;
	readonly primaryKeyColumn = libraries.primaryKeyColumn;
	readonly query = libraries.query;
	readonly selectMany = libraries.selectMany;
	readonly selectFirst = libraries.selectFirst;
	readonly findOrCreate = libraries.findOrCreate;
	readonly insert = libraries.insert;
	readonly insertReturning = libraries.insertReturning;
	readonly count = libraries.count;
	readonly isExists = libraries.isExists;
	readonly delete = libraries.delete;
	readonly deletePaths = libraryPaths.delete;

	private readonly libraryStatsCache = new MemoryCache<{ totalMediaFiles: number; totalSize: number }>({
		ttlMs: MINUTE,
		maxSize: 100,
		name: "library-stats",
	});
	private readonly pathStatsCache = new MemoryCache<{ fileCount: number; totalSize: number }>({
		ttlMs: MINUTE,
		maxSize: 500,
		name: "library-path-stats",
	});

	clearStatsCache(): void {
		this.libraryStatsCache.clear();
		this.pathStatsCache.clear();
	}

	async findActiveLibraryPaths(): Promise<Array<{ id: string; libraryId: string; path: string; isActive: boolean }>> {
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

	async findWithPaths(libraryId: string, tx?: DatabaseTransaction): Promise<LibraryWithRelations | undefined> {
		return await this.findById<never>({ primaryId: libraryId, tx });
	}

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & LibrarySorting & LibraryFilters,
	): Promise<PaginatedResponse<SelectFields<LibraryWithRelations, F>>> {
		return await findPageWithQueryMap(libraries, libraryQueryMap, query, (params) => this.findMany(params));
	}

	/**
	 * Direct existence probe for the create/update conflict checks. Must NOT go
	 * through `findPage` — its `total` rides the 10 s count cache, which hides
	 * freshly created duplicates and lets a duplicate slip through as 200.
	 */
	async hasNameConflict(name: string, type: "movies" | "tv_shows", excludeLibraryId?: string): Promise<boolean> {
		const row = await this.selectFirst({
			where: excludeLibraryId
				? and(eq(schema.libraries.name, name), eq(schema.libraries.type, type), ne(schema.libraries.id, excludeLibraryId))
				: and(eq(schema.libraries.name, name), eq(schema.libraries.type, type)),
		});

		return row !== undefined;
	}

	async createAndRead<F extends string>(body: CreateLibrary, query?: FieldsQuery<F>) {
		const { fields } = QueryUtils.parseStandard(query);

		return await this.create({ values: body, fields });
	}

	async findByIdForRead<F extends string>(libraryId: string, query?: FieldsQuery<F>) {
		const { fields } = QueryUtils.parseStandard(query);

		return await this.findById({ primaryId: libraryId, fields });
	}

	async updateAndRead<F extends string>(libraryId: string, body: UpdateLibrary, query?: FieldsQuery<F>) {
		const { fields } = QueryUtils.parseStandard(query);
		await this.update({ primaryId: libraryId, values: body });

		return await this.findById({ primaryId: libraryId, fields });
	}

	async update({ primaryId, values, tx }: { primaryId: string; values: UpdateLibrary; tx?: DatabaseTransaction }): Promise<void> {
		const run = async (activeTx: DatabaseTransaction | undefined): Promise<void> => {
			const { paths, ...libraryValues } = values;
			if (hasEntry(libraryValues)) {
				await libraries.update({ primaryId, values: libraryValues, tx: activeTx });
			}

			if (paths !== undefined) {
				await this.replacePaths(primaryId, paths, activeTx);
			}
		};
		// Atomic: a path conflict / invalid path must not leave the library row
		// updated without its paths.
		if (tx) await run(tx);
		else await databaseFactory.transaction(run);

		this.clearStatsCache();
	}

	async deleteWithDependents(libraryId: string): Promise<{
		artifactStorageKeys: string[];
		subtitleFilePaths: string[];
		subtitleIds: string[];
	}> {
		return await databaseFactory.transaction(async (tx) => {
			const client = databaseFactory.getClient({ tx });
			const [artifacts, subtitles, candidateMetadata] = await Promise.all([
				client
					.select({ storageKey: schema.mediaArtifacts.storageKey })
					.from(schema.mediaArtifacts)
					.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.mediaArtifacts.mediaFileId))
					.where(eq(schema.mediaFiles.libraryId, libraryId)),
				client
					.select({ id: schema.subtitles.id, filePath: schema.subtitles.filePath })
					.from(schema.subtitles)
					.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.subtitles.mediaFileId))
					.where(eq(schema.mediaFiles.libraryId, libraryId)),
				// Candidate metadata rows whose only media files belong to this library.
				// Must be captured BEFORE the media_files delete below.
				client
					.selectDistinct({ metadataId: schema.mediaFiles.metadataId })
					.from(schema.mediaFiles)
					.where(eq(schema.mediaFiles.libraryId, libraryId)),
			]);

			// `media_files.metadata_id` is NO ACTION (a metadata row can be shared by
			// media files from several libraries), so deleting metadata first violated
			// the FK and rolled the whole delete back. Delete media first, then the
			// now-orphan metadata.
			await client.delete(schema.mediaFiles).where(eq(schema.mediaFiles.libraryId, libraryId));

			const candidateMetadataIds = candidateMetadata.map((row) => row.metadataId);
			await forEachChunked(candidateMetadataIds, (metadataIds) =>
				client
					.delete(schema.metadata)
					.where(
						and(
							inArray(schema.metadata.id, metadataIds),
							notExists(client.select({ one: sql`1` }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, schema.metadata.id))),
						),
					),
			);

			// No FK on scan_state.library_id — delete the checkpoint explicitly so a
			// removed library leaves no orphan resume state.
			await client.delete(schema.scanState).where(eq(schema.scanState.libraryId, libraryId));
			await client.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));

			this.clearStatsCache();

			return {
				artifactStorageKeys: artifacts.map((artifact) => artifact.storageKey),
				subtitleFilePaths: subtitles.flatMap((subtitle) => (subtitle.filePath ? [subtitle.filePath] : [])),
				subtitleIds: subtitles.map((subtitle) => subtitle.id),
			};
		});
	}

	/**
	 * Get all libraries with pagination
	 */
	async findMany<F extends string>({
		fields,
		where,
		orderBy,
		limit,
		offset,
		tx,
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<LibraryWithRelations, F>>> {
		const data = await this.selectMany({ where, orderBy, limit, offset, tx });
		const relations = await this.loadRelations(
			data.map((library) => library.id),
			tx,
			fields,
		);

		return data.map((item) => this.toLibraryWithRelations(item, relations, fields));
	}

	/** Builds the library DTO (relations applied) shared by `findMany` and `findById`. */
	private toLibraryWithRelations<F extends string>(
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

	/**
	 * Get a single library by ID
	 */
	async findById<F extends string>({
		primaryId,
		fields,
		tx,
	}: {
		primaryId: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<LibraryWithRelations, F> | undefined> {
		const library = await this.selectFirst({ where: eq(this.primaryKeyColumn, primaryId), tx });

		if (!library) return undefined;

		const relations = await this.loadRelations([library.id], tx, fields);

		return this.toLibraryWithRelations(library, relations, fields);
	}

	/**
	 * Create a new library. Returns undefined when a concurrent request won the
	 * race and the (name, type) row already exists — the service turns that
	 * into a 409 instead of pretending the caller created it.
	 */
	async create<F extends string>({
		values: { name, type, metadataStorageMode = "database", sidecarFlavor = "reelvault", paths },
		fields,
		tx,
	}: {
		values: CreateLibrary;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<LibraryWithRelations, F> | undefined> {
		const run = async (activeTx: DatabaseTransaction | undefined): Promise<SelectFields<LibraryWithRelations, F> | undefined> => {
			const [inserted] = await this.insertReturning({
				values: {
					name,
					type,
					metadataStorageMode,
					sidecarFlavor,
				},
				onConflict: "doNothing",
				tx: activeTx,
			});
			if (!inserted) return undefined;

			await this.replacePaths(inserted.id, paths, activeTx);

			return await this.findById({
				primaryId: inserted.id,
				fields,
				tx: activeTx,
			});
		};

		// Atomic: the library row and its paths must be created together.
		const result = tx ? await run(tx) : await databaseFactory.transaction(run);
		this.clearStatsCache();

		return result;
	}

	private async loadRelations<F extends string>(
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

		// Uncached ids are aggregated in one query and cached per key; concurrent
		// callers sharing a library id reuse a single in-flight load.
		const libraryStatsPromise: Promise<Map<string, LibraryStats>> = tx
			? this.loadLibraryStats(libraryIds, tx)
			: this.libraryStatsCache.getOrSetMany(libraryIds, async (missing) => await this.loadLibraryStats(missing));

		const pathsPromise = shouldLoadPaths
			? client.select().from(schema.libraryPaths).where(inArray(schema.libraryPaths.libraryId, libraryIds))
			: Promise.resolve([]);
		let mediaFilesPromise: PromiseLike<Array<typeof schema.mediaFiles.$inferSelect>>;
		if (!shouldLoadMediaFiles) {
			mediaFilesPromise = Promise.resolve([]);
		} else if (mediaFileProjection) {
			mediaFilesPromise = client
				.select(mediaFileProjection)
				.from(schema.mediaFiles)
				.where(inArray(schema.mediaFiles.libraryId, libraryIds));
		} else {
			mediaFilesPromise = client.select().from(schema.mediaFiles).where(inArray(schema.mediaFiles.libraryId, libraryIds));
		}

		const [rawPaths, mediaFiles, libraryStats] = await Promise.all([pathsPromise, mediaFilesPromise, libraryStatsPromise]);

		const enrichedPaths = new Map<string, EnrichedLibraryPath[]>();
		if (shouldLoadPaths && rawPaths.length > 0) {
			await this.enrichPathsWithStats(enrichedPaths, libraryIds, rawPaths, libraryStats, tx);
		}

		return {
			paths: enrichedPaths,
			mediaFiles: groupBy(mediaFiles, (file) => file.libraryId),
			stats: libraryStats,
		};
	}

	/**
	 * Aggregates media-file counts/sizes per library, adding zero entries for
	 * empty libraries so the aggregate is not re-run for them. Callers that go
	 * through `getOrSetMany` get one shared query per uncached id set.
	 */
	private async loadLibraryStats(libraryIds: readonly string[], tx?: DatabaseTransaction): Promise<Map<string, LibraryStats>> {
		const stats = new Map<string, LibraryStats>();
		if (libraryIds.length === 0) return stats;

		const rows = await databaseFactory
			.getClient({ tx })
			.select({
				libraryId: schema.mediaFiles.libraryId,
				totalMediaFiles: sql<number>`count(*)`,
				totalSize: sql<number>`coalesce(sum(${schema.mediaFiles.size}), 0)`,
			})
			.from(schema.mediaFiles)
			.where(inArray(schema.mediaFiles.libraryId, libraryIds))
			.groupBy(schema.mediaFiles.libraryId);

		for (const row of rows) {
			stats.set(row.libraryId, { totalMediaFiles: row.totalMediaFiles, totalSize: row.totalSize });
		}

		for (const id of libraryIds) {
			if (!stats.has(id)) stats.set(id, { totalMediaFiles: 0, totalSize: 0 });
		}

		return stats;
	}

	/**
	 * Computes per-path file counts/sizes. Single-path libraries reuse the
	 * library-level stats; multi-path libraries resolve ownership through the
	 * prefix-stats cache (or the longest-prefix SQL below).
	 */
	private async enrichPathsWithStats(
		enrichedPaths: Map<string, EnrichedLibraryPath[]>,
		libraryIds: readonly string[],
		rawPaths: Array<typeof schema.libraryPaths.$inferSelect>,
		libraryStats: Map<string, LibraryStats>,
		tx?: DatabaseTransaction,
	): Promise<void> {
		const pathsByLibrary = groupBy(rawPaths, (path) => path.libraryId);
		const multiPathLibraryIds = libraryIds.filter((id) => (pathsByLibrary.get(id)?.length ?? 0) > 1);
		const pathStatsByPathId =
			multiPathLibraryIds.length > 0
				? await this.loadPathStats(pathsByLibrary, multiPathLibraryIds, tx)
				: new Map<string, LibraryPathStats>();

		for (const libraryId of libraryIds) {
			const libPaths = pathsByLibrary.get(libraryId) ?? [];

			if (libPaths.length === 0) {
				enrichedPaths.set(libraryId, []);
				continue;
			}

			if (libPaths.length === 1) {
				const stats = libraryStats.get(libraryId) ?? { totalMediaFiles: 0, totalSize: 0 };
				const singlePath = libPaths[0];
				if (singlePath) {
					enrichedPaths.set(libraryId, [
						{
							...singlePath,
							fileCount: stats.totalMediaFiles,
							totalSize: stats.totalSize,
							size: stats.totalSize,
						},
					]);
				}

				continue;
			}

			const pathsWithStats = libPaths.map((p) => {
				const stat = pathStatsByPathId.get(p.id) ?? { fileCount: 0, totalSize: 0 };

				return {
					...p,
					fileCount: stat.fileCount,
					totalSize: stat.totalSize,
					size: stat.totalSize,
				};
			});

			enrichedPaths.set(libraryId, pathsWithStats);
		}
	}

	/** Prefix stats for multi-path libraries: served from cache, refetched for uncached libraries via longest-prefix SQL. */
	private async loadPathStats(
		pathsByLibrary: Map<string, Array<typeof schema.libraryPaths.$inferSelect>>,
		multiPathLibraryIds: readonly string[],
		tx?: DatabaseTransaction,
	): Promise<Map<string, LibraryPathStats>> {
		const pathStatsByPathId = new Map<string, LibraryPathStats>();
		const uncachedMultiPathLibraryIds: string[] = [];
		if (!tx) {
			for (const libId of multiPathLibraryIds) {
				const libPaths = pathsByLibrary.get(libId) ?? [];
				let allCached = true;
				for (const p of libPaths) {
					const cached = this.pathStatsCache.get(p.id);
					if (cached) {
						pathStatsByPathId.set(p.id, cached);
					} else {
						allCached = false;
					}
				}

				if (!allCached) {
					uncachedMultiPathLibraryIds.push(libId);
				}
			}
		} else {
			uncachedMultiPathLibraryIds.push(...multiPathLibraryIds);
		}

		if (uncachedMultiPathLibraryIds.length === 0) return pathStatsByPathId;

		const client = databaseFactory.getClient({ tx });
		// Longest-path-prefix-wins ownership, computed in SQL instead of per-row prefix matching
		const fileKey = sql`RTRIM(REPLACE(${schema.mediaFiles.filePath}, '\\', '/'), '/')`;
		const pathKey = sql`RTRIM(REPLACE(p.path, '\\', '/'), '/')`;
		const prefixStats = await client
			.select({
				pathId: schema.libraryPaths.id,
				fileCount: sql<number>`count(*)`.mapWith(Number),
				totalSize: sql<number>`coalesce(sum(${schema.mediaFiles.size}), 0)`.mapWith(Number),
			})
			.from(schema.mediaFiles)
			.innerJoin(
				schema.libraryPaths,
				sql`${schema.libraryPaths.id} = (
					SELECT p.id
					FROM ${schema.libraryPaths} p
					WHERE p.library_id = ${schema.mediaFiles.libraryId}
						AND (${fileKey} = ${pathKey} OR substr(${fileKey}, 1, length(${pathKey}) + 1) = ${pathKey} || '/')
					ORDER BY length(${pathKey}) DESC
					LIMIT 1
				)`,
			)
			.where(inArray(schema.mediaFiles.libraryId, uncachedMultiPathLibraryIds))
			.groupBy(schema.libraryPaths.id);
		for (const row of prefixStats) {
			const entry = { fileCount: row.fileCount, totalSize: row.totalSize };
			pathStatsByPathId.set(row.pathId, entry);
			if (!tx) {
				this.pathStatsCache.set(row.pathId, entry);
			}
		}

		return pathStatsByPathId;
	}

	private async replacePaths(libraryId: string, paths: CreateLibraryPath[], tx?: DatabaseTransaction): Promise<void> {
		const normalizedPaths = [...toMap(paths, (item) => PathUtils.resolve(item.path.trim())).entries()];
		const client = databaseFactory.getClient({ tx });
		const stableKeys = normalizedPaths.map(([path]) => createLocalStableKey({ namespace: "library-path", value: path }));
		if (stableKeys.length === 0) {
			await this.deletePaths({ where: eq(schema.libraryPaths.libraryId, libraryId), tx });

			return;
		}

		await this.deletePaths({
			where: and(eq(schema.libraryPaths.libraryId, libraryId), notInArray(schema.libraryPaths.stableKey, stableKeys)),
			tx,
		});

		// The unique index on `path` makes a plain upsert silently re-parent the
		// existing row to THIS library, detaching it from the library that owned it.
		// A path shared between libraries is a caller error — reject it instead.
		const stolenRows = client
			.select({ id: schema.libraryPaths.id, path: schema.libraryPaths.path, libraryId: schema.libraryPaths.libraryId })
			.from(schema.libraryPaths)
			.where(and(inArray(schema.libraryPaths.stableKey, stableKeys), notInArray(schema.libraryPaths.libraryId, [libraryId])))
			.all();
		const stolen = stolenRows[0];
		if (stolen) {
			throw new ConflictError(`Path ${stolen.path} is already assigned to another library`, { code: "library.path_conflict" });
		}

		await client
			.insert(schema.libraryPaths)
			.values(
				normalizedPaths.map(([path, item]) => ({
					libraryId,
					path,
					metadataStorageMode: item.metadataStorageMode,
					stableKey: createLocalStableKey({ namespace: "library-path", value: path }),
				})),
			)
			.onConflictDoUpdate({
				target: schema.libraryPaths.stableKey,
				set: {
					libraryId: sql`excluded.library_id`,
					path: sql`excluded.path`,
					metadataStorageMode: sql`excluded.metadata_storage_mode`,
					isActive: sql`excluded.is_active`,
					updatedAt: new Date(),
				},
			});
	}
}

export const librariesRepository = new LibrariesRepository();
