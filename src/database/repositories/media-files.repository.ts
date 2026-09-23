import type {
	CreateMediaFile,
	FieldsConfig,
	FieldsQuery,
	MediaFileFilters,
	MediaFileSorting,
	MediaFileWithRelation,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	UpdateMediaFile,
} from "@reelvault/sdk/common";
import { and, asc, eq, getTableColumns, gt, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { ProjectedSelectParams } from "@/database/table-access";
import { defineTableAccess, findPageWithQueryMap, forEachChunked, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import { buildRelationProjection } from "@/database/utils/media-file-projection";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";
import { serverConfig } from "@/server.config";
import { MINUTE } from "@/server.constants";
import { chunk, groupBy, hasEntry, toMap, unique } from "@/utils/array.utils";
import { createLogger } from "@/utils/logger";
import { MemoryCache } from "@/utils/memory-cache";

const logger = createLogger("MediaFilesRepository");

/** Relation bundle as loaded from the database — only includes entries where ALL relations are present. */
interface LoadedMediaFileRelations {
	videoStreams: Array<typeof schema.mediaFileVideoStreams.$inferSelect>;
	audioStreams: Array<typeof schema.mediaFileAudioStreams.$inferSelect>;
	subtitles: Array<typeof schema.subtitles.$inferSelect>;
	library: MediaFileWithRelation["library"];
}

function hasMediaFileId<T>(item: T): item is T & { mediaFileId: string } {
	return typeof item === "object" && item !== null && "mediaFileId" in item && typeof item.mediaFileId === "string";
}

const mediaFiles = defineTableAccess("mediaFiles", {
	primaryKeyColumn: "id",
});
const mediaFileVideoStreams = defineTableAccess("mediaFileVideoStreams", {
	primaryKeyColumn: "mediaFileId",
});
const mediaFileAudioStreams = defineTableAccess("mediaFileAudioStreams", {
	primaryKeyColumn: "mediaFileId",
});
const mediaFileSubtitles = defineTableAccess("subtitles", {
	primaryKeyColumn: "id",
});
const videoStreamColumns = getTableColumns(schema.mediaFileVideoStreams);
const audioStreamColumns = getTableColumns(schema.mediaFileAudioStreams);
const libraryColumns = {
	id: schema.libraries.id,
	name: schema.libraries.name,
	type: schema.libraries.type,
	createdAt: schema.libraries.createdAt,
	updatedAt: schema.libraries.updatedAt,
};

const mediaFileAuditProjection = {
	mediaFileId: schema.mediaFiles.id,
	fileName: schema.mediaFiles.fileName,
	filePath: schema.mediaFiles.filePath,
	libraryId: schema.mediaFiles.libraryId,
	libraryName: schema.libraries.name,
	libraryType: schema.libraries.type,
	metadataId: schema.metadata.id,
	metadataTitle: schema.metadata.title,
	metadataOriginalTitle: schema.metadata.originalTitle,
	metadataReleaseDate: schema.metadata.releaseDate,
	metadataMatchScore: schema.metadata.matchScore,
	metadataType: schema.metadata.type,
	episodeNumber: schema.episodes.episodeNumber,
	seasonNumber: schema.seasons.seasonNumber,
};

export interface MediaFileAuditRow {
	mediaFileId: string;
	fileName: string;
	filePath: string;
	libraryId: string;
	libraryName: string | null;
	libraryType: string;
	metadataId: string;
	metadataTitle: string;
	metadataOriginalTitle: string | null;
	metadataReleaseDate: string | null;
	metadataMatchScore: number | null;
	metadataType: string;
	episodeNumber: number | null;
	seasonNumber: number | null;
}

const AUDIT_ROW_PAGE_SIZE = 1000;

const mediaFileQueryMap: QueryMap<MediaFileFilters, MediaFileSorting> = {
	filters: {
		libraryId: (value: string) => QueryFiltering.eq(schema.mediaFiles.libraryId, value),
		metadataId: (value: string) => QueryFiltering.eq(schema.mediaFiles.metadataId, value),
		movieId: (value: string) => QueryFiltering.eq(schema.mediaFiles.movieId, value),
		episodeId: (value: string) => QueryFiltering.eq(schema.mediaFiles.episodeId, value),
		filePath: (value: string) => QueryFiltering.like(schema.mediaFiles.filePath, value),
		fileName: (value: string) =>
			or(
				QueryFiltering.like(schema.mediaFiles.fileName, value),
				QueryFiltering.like(schema.mediaFiles.filePath, value),
				QueryFiltering.like(schema.mediaFiles.id, value),
			),
	},
	orderBy: {
		fileName: schema.mediaFiles.fileName,
		filePath: schema.mediaFiles.filePath,
		size: schema.mediaFiles.size,
		createdAt: schema.mediaFiles.createdAt,
		updatedAt: schema.mediaFiles.updatedAt,
	},
	defaults: { sortBy: "createdAt", sortOrder: "desc" },
};

type TechnicalMediaFileData = Pick<
	CreateMediaFile,
	"formatName" | "duration" | "bitRate" | "source" | "edition" | "qualityTag" | "videoStreams" | "audioStreams" | "subtitles"
>;

/** Maps the cleanup rows shared by the single- and multi-file delete paths. */
function toCleanupData(subtitles: Array<{ id: string; filePath: string | null }>, artifacts: Array<{ storageKey: string }>) {
	return {
		artifactStorageKeys: artifacts.map((artifact) => artifact.storageKey),
		subtitleFilePaths: subtitles.map((subtitle) => subtitle.filePath),
		subtitleIds: subtitles.map((subtitle) => subtitle.id),
	};
}

class MediaRepository {
	readonly table = schema.mediaFiles;
	readonly primaryKeyColumn = mediaFiles.primaryKeyColumn;
	readonly query = mediaFiles.query;
	readonly selectMany = mediaFiles.selectMany;
	readonly selectFirst = mediaFiles.selectFirst;
	readonly findOrCreate = mediaFiles.findOrCreate;
	readonly insert = mediaFiles.insert;
	readonly update = mediaFiles.update;
	readonly delete = mediaFiles.delete;
	readonly count = mediaFiles.count;
	readonly isExists = mediaFiles.isExists;
	readonly insertReturning = mediaFiles.insertReturning;
	readonly updateReturning = mediaFiles.updateReturning;
	readonly updateAndReturn = mediaFiles.updateAndReturn;
	readonly deleteReturning = mediaFiles.deleteReturning;
	readonly deleteAndReturn = mediaFiles.deleteAndReturn;
	readonly findByIds = mediaFiles.findByIds;
	readonly findByColumnIn = mediaFiles.findByColumnIn;
	readonly insertVideoStreams = mediaFileVideoStreams.insert;
	readonly insertAudioStreams = mediaFileAudioStreams.insert;
	readonly insertSubtitles = mediaFileSubtitles.insert;
	readonly deleteSubtitles = mediaFileSubtitles.delete;
	readonly deleteVideoStreams = mediaFileVideoStreams.delete;
	readonly deleteAudioStreams = mediaFileAudioStreams.delete;

	private readonly streamingDurationCache = new MemoryCache<{ id: string; duration: number | null }>({
		ttlMs: 30 * MINUTE,
		maxSize: 5000,
		name: "media-file-streaming-duration",
	});

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & MediaFileFilters & MediaFileSorting,
	): Promise<PaginatedResponse<SelectFields<MediaFileWithRelation, F>>> {
		return await findPageWithQueryMap(mediaFiles, mediaFileQueryMap, query, (params) => this.findMany(params));
	}

	async findByIdForRead<F extends string>(mediaFileId: string, query?: FieldsQuery<F>) {
		const { fields } = QueryUtils.parseStandard(query);

		return await this.findByPrimaryId({ primaryId: mediaFileId, fields });
	}

	async updateAndRead<F extends string>(mediaFileId: string, body: UpdateMediaFile, query?: FieldsQuery<F>) {
		const { fields } = QueryUtils.parseStandard(query);
		const { isDefault, ...values } = body;
		this.streamingDurationCache.delete(mediaFileId);
		await databaseFactory.transaction(async (tx) => {
			if (isDefault !== undefined) await this.setDefault(mediaFileId, isDefault, tx);

			const hasValues = hasEntry(values);
			if (hasValues) await this.update({ primaryId: mediaFileId, values, tx });
		});

		return await this.findByPrimaryId({ primaryId: mediaFileId, fields });
	}

	async deleteAndGetCleanup(mediaFileId: string) {
		this.streamingDurationCache.delete(mediaFileId);

		return await databaseFactory.transaction(async (tx) => {
			const cleanup = await this.findCleanupData(mediaFileId, tx);
			await this.delete({ primaryId: mediaFileId, tx });

			return cleanup;
		});
	}

	/**
	 * Repoints a media file to new metadata/movie/episode and atomically decides
	 * `isDefault` — a concurrent reassign to the same target must not leave two
	 * defaults behind.
	 */
	async reassign({
		mediaFileId,
		metadataId,
		movieId,
		episodeId,
	}: {
		mediaFileId: string;
		metadataId: string;
		movieId: string | null;
		episodeId: string | null;
	}): Promise<void> {
		this.streamingDurationCache.delete(mediaFileId);
		await databaseFactory.transaction(async (tx) => {
			const existingDefault = await this.selectFirst({
				where: movieId
					? and(eq(this.table.movieId, movieId), eq(this.table.isDefault, true), ne(this.table.id, mediaFileId))
					: and(eq(this.table.episodeId, episodeId ?? ""), eq(this.table.isDefault, true), ne(this.table.id, mediaFileId)),
				tx,
			});

			await this.update({
				primaryId: mediaFileId,
				values: { metadataId, movieId, episodeId, isDefault: !existingDefault },
				tx,
			});
		});
	}

	async findIdByFilePath(filePath: string) {
		return await this.findByFilePath({ filePath, fields: QueryFields.parse({ fields: "id" }) });
	}

	/** Lightweight connectivity probe for the health endpoint. */
	async ping(): Promise<void> {
		await this.selectFirst();
	}

	async findForTechnicalRefresh(mediaFileId: string) {
		return await this.findByPrimaryId({
			primaryId: mediaFileId,
			fields: QueryFields.parse({ fields: "id,filePath,size,sourceMtimeMs,audioStreams" }),
		});
	}

	async findForPlaybackSession(mediaFileId: string) {
		return await this.findByPrimaryId({
			primaryId: mediaFileId,
			fields: QueryFields.parse({ fields: "id,filePath,duration,size,sourceMtimeMs,videoStreams,audioStreams,subtitles,isEnabled" }),
		});
	}

	async findForStreamingDuration(mediaFileId: string) {
		const cached = this.streamingDurationCache.get(mediaFileId);
		if (cached) return cached;

		const record = await this.findByPrimaryId({
			primaryId: mediaFileId,
			fields: QueryFields.parse({ fields: "id,duration" }),
		});
		if (record) {
			this.streamingDurationCache.set(mediaFileId, record);
		}

		return record;
	}

	async findForStreamingDiagnostics(mediaFileId: string) {
		return await this.findByPrimaryId({
			primaryId: mediaFileId,
			fields: QueryFields.parse({ fields: "id,fileName,formatName,duration,size,bitRate,videoStreams,audioStreams" }),
		});
	}

	async findForSubtitleExtraction(mediaFileId: string) {
		return await this.findByPrimaryId({
			primaryId: mediaFileId,
			fields: QueryFields.parse({ fields: "id,filePath" }),
		});
	}

	async replaceTechnicalData({
		mediaFileId,
		data,
		size,
		sourceMtimeMs,
	}: {
		mediaFileId: string;
		data: TechnicalMediaFileData;
		size: number;
		sourceMtimeMs: number;
	}) {
		this.streamingDurationCache.delete(mediaFileId);
		await databaseFactory.transaction(async (tx) => {
			await this.update({
				primaryId: mediaFileId,
				values: {
					formatName: data.formatName,
					duration: data.duration,
					size,
					sourceMtimeMs,
					bitRate: data.bitRate,
					source: data.source,
					edition: data.edition,
					qualityTag: data.qualityTag,
				},
				tx,
			});
			await this.replaceStreams(mediaFileId, data, tx);
			await this.replaceEmbeddedSubtitles(mediaFileId, data.subtitles ?? [], tx);
		});
	}

	async deleteByLibraryAndPathsAndGetCleanup(libraryId: string, filePaths: string[]) {
		this.streamingDurationCache.clear();

		return await databaseFactory.transaction(async (tx) => {
			const matchingMediaFiles = await this.findByLibraryAndPaths({ libraryId, filePaths, tx });
			const cleanup = await this.findCleanupDataByMediaFileIds(
				matchingMediaFiles.map((mediaFile) => mediaFile.id),
				tx,
			);
			await this.deleteByLibraryAndPaths({ libraryId, filePaths, tx });

			return {
				...cleanup,
				removedMediaFiles: matchingMediaFiles.map((mediaFile) => ({ id: mediaFile.id, filePath: mediaFile.filePath })),
			};
		});
	}

	async findAuditRow(mediaFileId: string) {
		const client = databaseFactory.getClient();
		const [row] = await client
			.select(mediaFileAuditProjection)
			.from(schema.mediaFiles)
			.innerJoin(schema.libraries, eq(schema.mediaFiles.libraryId, schema.libraries.id))
			.innerJoin(schema.metadata, eq(schema.mediaFiles.metadataId, schema.metadata.id))
			.leftJoin(schema.episodes, eq(schema.mediaFiles.episodeId, schema.episodes.id))
			.leftJoin(schema.seasons, eq(schema.episodes.seasonId, schema.seasons.id))
			.where(eq(schema.mediaFiles.id, mediaFileId))
			.limit(1);

		return row;
	}

	/**
	 * Streams audit rows page-by-page to `onPage`, returning the total row count.
	 * The caller can `await` between pages so a full-catalog audit never starves
	 * the event loop (SQLite is synchronous).
	 */
	async scanAuditRows(onPage: (rows: MediaFileAuditRow[]) => Promise<void> | void): Promise<number> {
		let total = 0;
		let cursor: string | undefined;
		for (;;) {
			const rows = await this.findAuditRowsPage(cursor);
			await onPage(rows);
			total += rows.length;
			if (rows.length < AUDIT_ROW_PAGE_SIZE) break;

			const lastId = rows.at(-1)?.mediaFileId;
			if (!lastId) break;

			cursor = lastId;
		}

		return total;
	}

	private async findAuditRowsPage(cursor?: string) {
		return await databaseFactory
			.getClient()
			.select(mediaFileAuditProjection)
			.from(schema.mediaFiles)
			.innerJoin(schema.libraries, eq(schema.mediaFiles.libraryId, schema.libraries.id))
			.innerJoin(schema.metadata, eq(schema.mediaFiles.metadataId, schema.metadata.id))
			.leftJoin(schema.episodes, eq(schema.mediaFiles.episodeId, schema.episodes.id))
			.leftJoin(schema.seasons, eq(schema.episodes.seasonId, schema.seasons.id))
			.where(cursor ? gt(schema.mediaFiles.id, cursor) : undefined)
			.orderBy(asc(schema.mediaFiles.id))
			.limit(AUDIT_ROW_PAGE_SIZE);
	}

	async findAllAuditRowIds() {
		const allIds: string[] = [];
		let cursor: string | undefined;
		for (;;) {
			const rows = await databaseFactory
				.getClient()
				.select({ id: schema.mediaFiles.id })
				.from(schema.mediaFiles)
				.innerJoin(schema.metadata, eq(schema.mediaFiles.metadataId, schema.metadata.id))
				.where(cursor ? gt(schema.mediaFiles.id, cursor) : undefined)
				.orderBy(asc(schema.mediaFiles.id))
				.limit(AUDIT_ROW_PAGE_SIZE);
			if (rows.length === 0) break;

			for (const row of rows) allIds.push(row.id);

			if (rows.length < AUDIT_ROW_PAGE_SIZE) break;

			const lastId = rows.at(-1)?.id;
			if (!lastId) break;

			cursor = lastId;
		}

		return allIds;
	}

	/**
	 * Pass an existing `tx` when creating many rows in a loop (e.g. during a library scan) so callers
	 * can batch several inserts into a single commit instead of paying a transaction/fsync cost per row.
	 * When no `tx` is given, behaves exactly as before and opens its own transaction.
	 */
	async createWithStreams(data: CreateMediaFile, tx?: DatabaseTransaction) {
		const { videoStreams, audioStreams, subtitles = [], ...mediaFileValues } = data;

		const run = async (runTx: DatabaseTransaction) => {
			const [createdMediaFile] = await runTx.insert(this.table).values(mediaFileValues).onConflictDoNothing().returning();
			if (!createdMediaFile) {
				const existingMediaFile = await this.selectFirst({ where: eq(this.table.filePath, data.filePath), tx: runTx });
				if (!existingMediaFile) throw new Error("Media file insert conflicted but no existing row was found");

				return { mediaFile: existingMediaFile, created: false };
			}

			await Promise.all([
				this.insertVideoStreams({
					values: videoStreams.map((stream) => ({ ...stream, mediaFileId: createdMediaFile.id })),
					tx: runTx,
				}),
				this.insertAudioStreams({
					values: audioStreams.map((stream) => ({ ...stream, mediaFileId: createdMediaFile.id })),
					tx: runTx,
				}),
				this.insertSubtitles({
					values: subtitles.map((subtitle) => ({
						...subtitle,
						mediaFileId: createdMediaFile.id,
						type: "embedded" as const,
						filePath: null,
					})),
					tx: runTx,
				}),
			]);

			return { mediaFile: createdMediaFile, created: true };
		};

		return tx ? await run(tx) : await databaseFactory.transaction(run);
	}

	/** Marks the post-create sidecar write so a retry does not repeat it. */
	async markIngestSidecarWritten(mediaFileId: string): Promise<void> {
		await this.upsertIngestState(mediaFileId, { sidecarWrittenAt: new Date() });
	}

	/** Marks the `media.file.discovered` emission so a retry does not duplicate it. */
	async markIngestDiscoveredEmitted(mediaFileId: string): Promise<void> {
		await this.upsertIngestState(mediaFileId, { discoveredEmittedAt: new Date() });
	}

	/** Which post-create ingest side effects already ran for this file. */
	async findIngestProgress(mediaFileId: string): Promise<{ sidecarWritten: boolean; discoveredEmitted: boolean }> {
		const [row] = await databaseFactory
			.getClient()
			.select({
				sidecarWrittenAt: schema.mediaFileIngestState.sidecarWrittenAt,
				discoveredEmittedAt: schema.mediaFileIngestState.discoveredEmittedAt,
			})
			.from(schema.mediaFileIngestState)
			.where(eq(schema.mediaFileIngestState.mediaFileId, mediaFileId))
			.limit(1);

		return { sidecarWritten: row?.sidecarWrittenAt != null, discoveredEmitted: row?.discoveredEmittedAt != null };
	}

	private async upsertIngestState(mediaFileId: string, values: { sidecarWrittenAt?: Date; discoveredEmittedAt?: Date }): Promise<void> {
		const now = new Date();
		await databaseFactory
			.getClient()
			.insert(schema.mediaFileIngestState)
			.values({ mediaFileId, createdAt: now, updatedAt: now, ...values })
			.onConflictDoUpdate({
				target: schema.mediaFileIngestState.mediaFileId,
				set: { ...values, updatedAt: now },
			});
	}

	async replaceStreams(mediaFileId: string, streams: Pick<CreateMediaFile, "videoStreams" | "audioStreams">, tx: DatabaseTransaction) {
		await Promise.all([
			this.deleteVideoStreams({ where: eq(schema.mediaFileVideoStreams.mediaFileId, mediaFileId), tx }),
			this.deleteAudioStreams({ where: eq(schema.mediaFileAudioStreams.mediaFileId, mediaFileId), tx }),
		]);

		await Promise.all([
			this.insertVideoStreams({ values: streams.videoStreams.map((stream) => ({ ...stream, mediaFileId })), tx }),
			this.insertAudioStreams({ values: streams.audioStreams.map((stream) => ({ ...stream, mediaFileId })), tx }),
		]);
	}

	async replaceEmbeddedSubtitles(
		mediaFileId: string,
		subtitles: NonNullable<CreateMediaFile["subtitles"]>,
		tx: DatabaseTransaction,
	): Promise<void> {
		await this.deleteSubtitles({
			where: and(eq(schema.subtitles.mediaFileId, mediaFileId), eq(schema.subtitles.type, "embedded")),
			tx,
		});
		await this.insertSubtitles({
			values: subtitles.map((subtitle) => ({ ...subtitle, mediaFileId, type: "embedded" as const, filePath: null })),
			tx,
		});
	}

	async setDefault(mediaFileId: string, isDefault: boolean, tx: DatabaseTransaction): Promise<void> {
		const mediaFile = await this.selectFirst({
			where: eq(this.primaryKeyColumn, mediaFileId),
			tx,
		});
		if (!mediaFile) return;

		const client = databaseFactory.getClient({ tx });
		let target: SQL | undefined;
		if (mediaFile.movieId) {
			target = eq(this.table.movieId, mediaFile.movieId);
		} else if (mediaFile.episodeId) {
			target = eq(this.table.episodeId, mediaFile.episodeId);
		}

		if (!target) throw new Error(`Media file ${mediaFileId} has no movie or episode target`);

		if (isDefault) {
			await client
				.update(this.table)
				.set({ isDefault: false })
				.where(and(target, eq(this.table.isDefault, true)));
		}

		await client.update(this.table).set({ isDefault }).where(eq(this.primaryKeyColumn, mediaFileId));
	}

	/**
	 * Get all media files with pagination
	 */
	async findMany<F extends string>({
		fields,
		where,
		orderBy,
		limit,
		offset,
		tx,
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<MediaFileWithRelation, F>>> {
		const data = await this.selectMany({ where, orderBy, limit, offset, tx });
		const related = await this.loadRelations(data, tx, fields);

		const results: Array<SelectFields<MediaFileWithRelation, F>> = [];
		for (const item of data) {
			const rel = related.get(item.id);
			if (!rel) continue;

			results.push(QueryFields.apply<MediaFileWithRelation, F>({ ...item, ...rel }, fields));
		}

		return results;
	}

	/** All flat media-file rows of a title, zero relation queries. findMany
	 * without fields loads video/audio streams + subtitles + library per batch —
	 * composite views shipping only root rows must use this. */
	async findRootsByMetadataId(metadataId: string): Promise<Array<typeof schema.mediaFiles.$inferSelect>> {
		return await this.selectMany({ where: eq(this.table.metadataId, metadataId) });
	}

	async findAllIdentities(tx?: DatabaseTransaction): Promise<
		Array<{
			id: string;
			metadataId: string;
		}>
	> {
		// Keyset-paged accumulation — avoids one giant SELECT on large libraries.
		const allRows: Array<{ id: string; metadataId: string }> = [];
		let cursor: string | undefined;
		for (;;) {
			const rows = await databaseFactory
				.getClient({ tx })
				.select({ id: this.table.id, metadataId: this.table.metadataId })
				.from(this.table)
				.where(cursor ? gt(this.table.id, cursor) : undefined)
				.orderBy(asc(this.table.id))
				.limit(AUDIT_ROW_PAGE_SIZE);
			allRows.push(...rows);
			if (rows.length < AUDIT_ROW_PAGE_SIZE) break;

			const lastId = rows.at(-1)?.id;
			if (!lastId) break;

			cursor = lastId;
		}

		return allRows;
	}

	async findIdentity(id: string, tx?: DatabaseTransaction): Promise<{ id: string; metadataId: string } | undefined> {
		const [row] = await databaseFactory
			.getClient({ tx })
			.select({ id: this.table.id, metadataId: this.table.metadataId })
			.from(this.table)
			.where(eq(this.table.id, id))
			.limit(1);

		return row;
	}

	/** Batched findIdentity — a scan enqueueing refreshes for N changed files
	 * used to run one single-row SELECT per file at bounded concurrency. */
	async findIdentitiesByIds(ids: readonly string[], tx?: DatabaseTransaction): Promise<Array<{ id: string; metadataId: string }>> {
		if (ids.length === 0) return [];

		return await mapChunked(ids, (chunkIds) =>
			databaseFactory
				.getClient({ tx })
				.select({ id: this.table.id, metadataId: this.table.metadataId })
				.from(this.table)
				.where(inArray(this.table.id, chunkIds)),
		);
	}

	/**
	 * Get a single media file by ID
	 */
	async findByPrimaryId<F extends string>({
		primaryId,
		fields,
		tx,
	}: {
		primaryId: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<MediaFileWithRelation, F> | undefined> {
		const media = await this.selectFirst({ where: eq(this.primaryKeyColumn, primaryId), tx });

		if (!media) return undefined;

		const relations = (await this.loadRelations([media], tx, fields)).get(media.id);
		if (!relations) return undefined;

		return QueryFields.apply<MediaFileWithRelation, F>({ ...media, ...relations }, fields);
	}

	/**
	 * Get a media file by file path
	 */
	async findByFilePath<F extends string>({
		filePath,
		fields,
		tx,
	}: {
		filePath: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<MediaFileWithRelation, F> | undefined> {
		const media = await this.selectFirst({ where: eq(this.table.filePath, filePath), tx });

		if (!media) return undefined;

		const relations = (await this.loadRelations([media], tx, fields)).get(media.id);
		if (!relations) return undefined;

		return QueryFields.apply<MediaFileWithRelation, F>({ ...media, ...relations }, fields);
	}

	/** Keyset page of file stats — the scanner diffs the library page-by-page instead of loading every row. */
	async findStatsByLibraryIdPage(
		libraryId: string,
		afterId: string | undefined,
		limit: number,
		tx?: DatabaseTransaction,
	): Promise<
		Array<{
			id: string;
			filePath: string;
			size: number | null;
			sourceMtimeMs: number | null;
		}>
	> {
		return await databaseFactory
			.getClient({ tx })
			.select({
				id: this.table.id,
				filePath: this.table.filePath,
				size: this.table.size,
				sourceMtimeMs: this.table.sourceMtimeMs,
			})
			.from(this.table)
			.where(and(eq(this.table.libraryId, libraryId), afterId ? gt(this.table.id, afterId) : undefined))
			.orderBy(asc(this.table.id))
			.limit(limit);
	}

	async findByLibraryAndPaths({ libraryId, filePaths, tx }: { libraryId: string; filePaths: string[]; tx?: DatabaseTransaction }) {
		if (filePaths.length === 0) return [];

		return await mapChunked(filePaths, (pathChunk) =>
			this.selectMany({
				where: and(eq(this.table.libraryId, libraryId), inArray(this.table.filePath, pathChunk)),
				tx,
			}),
		);
	}

	async deleteByLibraryAndPaths({
		libraryId,
		filePaths,
		tx,
	}: {
		libraryId: string;
		filePaths: string[];
		tx?: DatabaseTransaction | undefined;
	}): Promise<void> {
		if (filePaths.length === 0) return;

		await forEachChunked(filePaths, (pathChunk) =>
			this.delete({ where: and(eq(this.table.libraryId, libraryId), inArray(this.table.filePath, pathChunk)), tx }),
		);
	}

	async findCleanupDataByMediaFileIds(mediaFileIds: readonly string[], tx?: DatabaseTransaction) {
		if (mediaFileIds.length === 0) return toCleanupData([], []);

		const client = databaseFactory.getClient({ tx });
		const idChunks = chunk(mediaFileIds, serverConfig.database.queryChunkSize);
		const [subtitleResults, artifactResults] = await Promise.all([
			Promise.all(
				idChunks.map((idChunk) =>
					client
						.select({ id: schema.subtitles.id, filePath: schema.subtitles.filePath })
						.from(schema.subtitles)
						.where(inArray(schema.subtitles.mediaFileId, idChunk)),
				),
			),
			Promise.all(
				idChunks.map((idChunk) =>
					client
						.select({ storageKey: schema.mediaArtifacts.storageKey })
						.from(schema.mediaArtifacts)
						.where(inArray(schema.mediaArtifacts.mediaFileId, idChunk)),
				),
			),
		]);

		return toCleanupData(subtitleResults.flat(), artifactResults.flat());
	}

	async findCleanupData(mediaFileId: string, tx?: DatabaseTransaction) {
		// Single-file deletes are the common path — skip chunking and the nested Promise.all.
		const client = databaseFactory.getClient({ tx });
		const [subtitles, artifacts] = await Promise.all([
			client
				.select({ id: schema.subtitles.id, filePath: schema.subtitles.filePath })
				.from(schema.subtitles)
				.where(eq(schema.subtitles.mediaFileId, mediaFileId)),
			client
				.select({ storageKey: schema.mediaArtifacts.storageKey })
				.from(schema.mediaArtifacts)
				.where(eq(schema.mediaArtifacts.mediaFileId, mediaFileId)),
		]);

		return toCleanupData(subtitles, artifacts);
	}

	/**
	 * Loads video/audio streams and the parent library for a set of media files.
	 *
	 * Takes the already-fetched media file rows (not just their IDs) so it can read `libraryId`
	 * directly off them — previously this ran a second `SELECT * FROM media_files WHERE id IN (...)`
	 * purely to recover `libraryId`, duplicating a query the caller had already made.
	 */
	private async loadRelations<F extends string>(
		mediaFileRows: Array<{ id: string; libraryId: string }>,
		tx: DatabaseTransaction | undefined,
		fields?: FieldsConfig<F>,
	): Promise<Map<string, LoadedMediaFileRelations>> {
		if (mediaFileRows.length === 0) return new Map();

		const mediaFileIds = mediaFileRows.map((mediaFile) => mediaFile.id);
		const client = databaseFactory.getClient({ tx });
		const videoProjection = fields?.relations.videoStreams?.length
			? buildRelationProjection(fields.relations.videoStreams, videoStreamColumns, ["mediaFileId"])
			: undefined;
		const audioProjection = fields?.relations.audioStreams?.length
			? buildRelationProjection(fields.relations.audioStreams, audioStreamColumns, ["mediaFileId"])
			: undefined;
		const libraryProjection = fields?.relations.library?.length
			? buildRelationProjection(fields.relations.library, libraryColumns, ["id"])
			: undefined;
		// The relation bundle must be complete for every row (see LoadedMediaFileRelations):
		// callers omit rows whose relations did not load, so `library` has to be fetched
		// even when the field projection excludes it. Skipping it here made every
		// projected read (e.g. mediaFileFields without `library`) return "not found".
		const libraryIds = unique(mediaFileRows, (mediaFile) => mediaFile.libraryId);

		let videoStreamsQuery: PromiseLike<Array<typeof schema.mediaFileVideoStreams.$inferSelect>>;
		if (videoProjection) {
			videoStreamsQuery = client
				.select(videoProjection)
				.from(schema.mediaFileVideoStreams)
				.where(inArray(schema.mediaFileVideoStreams.mediaFileId, mediaFileIds));
		} else if (QueryFields.includes(fields, "videoStreams")) {
			videoStreamsQuery = client
				.select()
				.from(schema.mediaFileVideoStreams)
				.where(inArray(schema.mediaFileVideoStreams.mediaFileId, mediaFileIds));
		} else {
			videoStreamsQuery = Promise.resolve([]);
		}

		let audioStreamsQuery: PromiseLike<Array<typeof schema.mediaFileAudioStreams.$inferSelect>>;
		if (audioProjection) {
			audioStreamsQuery = client
				.select(audioProjection)
				.from(schema.mediaFileAudioStreams)
				.where(inArray(schema.mediaFileAudioStreams.mediaFileId, mediaFileIds));
		} else if (QueryFields.includes(fields, "audioStreams")) {
			audioStreamsQuery = client
				.select()
				.from(schema.mediaFileAudioStreams)
				.where(inArray(schema.mediaFileAudioStreams.mediaFileId, mediaFileIds));
		} else {
			audioStreamsQuery = Promise.resolve([]);
		}

		let librariesQuery: PromiseLike<Array<MediaFileWithRelation["library"]>>;
		if (libraryProjection) {
			librariesQuery = client.select(libraryProjection).from(schema.libraries).where(inArray(schema.libraries.id, libraryIds));
		} else if (libraryIds.length > 0) {
			librariesQuery = client.select().from(schema.libraries).where(inArray(schema.libraries.id, libraryIds));
		} else {
			librariesQuery = Promise.resolve([]);
		}

		const [videoStreams, audioStreams, subtitles, libraries] = await Promise.all([
			videoStreamsQuery,
			audioStreamsQuery,
			QueryFields.includes(fields, "subtitles")
				? client.select().from(schema.subtitles).where(inArray(schema.subtitles.mediaFileId, mediaFileIds))
				: Promise.resolve([]),
			librariesQuery,
		]);

		// Manual Map: `libraries` is a union of projected-row types from the
		// conditional select above — toMap's generic inference collapses it.
		const librariesById = new Map(libraries.map((library) => [library.id, library] as const));
		const libraryIdByMediaFileId = toMap(
			mediaFileRows,
			(mediaFile) => mediaFile.id,
			(mediaFile) => mediaFile.libraryId,
		);
		const videosByMediaFileId = groupBy(
			videoStreams.filter((item) => hasMediaFileId(item)),
			(item) => item.mediaFileId,
		);
		const audioByMediaFileId = groupBy(
			audioStreams.filter((item) => hasMediaFileId(item)),
			(item) => item.mediaFileId,
		);
		const subtitlesByMediaFileId = groupBy(
			subtitles.filter((item) => hasMediaFileId(item)),
			(item) => item.mediaFileId,
		);

		const result = new Map<string, LoadedMediaFileRelations>();
		for (const mediaFileId of mediaFileIds) {
			const libraryId = libraryIdByMediaFileId.get(mediaFileId) ?? "";
			const library = librariesById.get(libraryId);
			if (!library) {
				// Dangling libraryId (library removed out from under the row). The row
				// cannot satisfy MediaFileWithRelation's `library` contract, so it is
				// omitted from results — but never silently.
				logger.warn("Media file references a missing library — omitted from results", { mediaFileId, libraryId });
				continue;
			}

			result.set(mediaFileId, {
				videoStreams: videosByMediaFileId.get(mediaFileId) ?? [],
				audioStreams: audioByMediaFileId.get(mediaFileId) ?? [],
				subtitles: subtitlesByMediaFileId.get(mediaFileId) ?? [],
				library,
			});
		}

		return result;
	}

	/**
	 * Find media files whose `libraryId` references a non-existent library.
	 * Returns IDs in batches to avoid unbounded memory.
	 */
	async findOrphanedMediaFileIds(batchSize = 500, tx?: DatabaseTransaction): Promise<string[]> {
		const client = databaseFactory.getClient({ tx });
		const orphanedIds: string[] = [];
		let cursor: string | undefined;

		for (;;) {
			const batch = await client
				.select({ id: schema.mediaFiles.id })
				.from(schema.mediaFiles)
				.leftJoin(schema.libraries, eq(schema.mediaFiles.libraryId, schema.libraries.id))
				.where(cursor ? and(isNull(schema.libraries.id), gt(schema.mediaFiles.id, cursor)) : isNull(schema.libraries.id))
				.orderBy(asc(schema.mediaFiles.id))
				.limit(batchSize);

			if (batch.length === 0) break;

			for (const row of batch) orphanedIds.push(row.id);

			cursor = batch.at(-1)?.id;
			if (batch.length < batchSize) break;
		}

		return orphanedIds;
	}

	/**
	 * Delete media files by IDs. FK cascade handles dependent rows
	 * (video/audio streams, subtitles, artifacts).
	 */
	async deleteByIds(ids: string[], tx?: DatabaseTransaction): Promise<number> {
		if (ids.length === 0) return 0;

		let deleted = 0;
		const client = databaseFactory.getClient({ tx });
		await forEachChunked(ids, async (idChunk) => {
			const result = await client.delete(schema.mediaFiles).where(inArray(schema.mediaFiles.id, idChunk));
			deleted += result.changes;
		});

		return deleted;
	}
}

export const mediaRepository = new MediaRepository();
