import type { CursorPaginatedResponse, CursorPaginationQuery, WatchedHistoryWithRelations } from "@reelvault/sdk/common";
import { and, asc, desc, eq, inArray, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import {
	type CreatedAtCursor,
	decodeCursorFor,
	KeysetCursor,
	keysetWhere,
} from "@/integrations/drizzle-orm/query/keyset/keyset-cursor.utils";
import { QueryPagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { QueryUtils } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { cachedCount, filterSignature } from "@/integrations/drizzle-orm/query/table-access/row-count.cache";
import { metadataImageOn, metadataOn } from "@/integrations/drizzle-orm/utils/join-conditions.utils";
import { unique } from "@/utils/array.utils";
import { watchedHistory } from "./shared.schema";

export interface WatchedHistoryPageOptions {
	limit?: number | undefined;
	offset?: number | undefined;
	sortBy?: "watchedAt" | "createdAt" | undefined;
	sortOrder?: "asc" | "desc" | undefined;
	/** Keyset position — takes precedence over offset and forces watchedAt-desc ordering. */
	cursor?: CreatedAtCursor | undefined;
}

/** Cursor mode orders by the full key (watchedAt, id); the offset path adds the
 * id tiebreaker so pages stay deterministic for equal timestamps. */
function orderByFor(cursor: CreatedAtCursor | undefined, sortColumn: SQLWrapper, sortOrder: "asc" | "desc"): SQL[] {
	if (cursor) return [sql`${desc(schema.watchedHistory.watchedAt)}, ${desc(schema.watchedHistory.id)}`];

	return [sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn), sql`${schema.watchedHistory.id}`];
}

export async function countForProfile(profileId: string): Promise<number> {
	return await watchedHistory.count({ where: eq(schema.watchedHistory.profileId, profileId) });
}

/** A profile's plays with the title, episode and season they belong to, plus each title's backdrop. */
export async function findWatchedWithMedia(profileId: string, options: WatchedHistoryPageOptions) {
	const { limit = 50, offset = 0, sortBy = "watchedAt", sortOrder = "desc", cursor } = options;
	const client = databaseFactory.getClient();
	const sortColumn = sortBy === "createdAt" ? schema.watchedHistory.createdAt : schema.watchedHistory.watchedAt;

	// Cursor mode orders by the full key (watchedAt, id) so pagination stays
	// deterministic even when rows share a timestamp.
	let where: SQL | undefined;
	if (cursor) {
		where = and(
			eq(schema.watchedHistory.profileId, profileId),
			keysetWhere(schema.watchedHistory.watchedAt, schema.watchedHistory.id, cursor),
		);
	} else {
		where = eq(schema.watchedHistory.profileId, profileId);
	}

	const rows = await client
		.select({
			history: schema.watchedHistory,
			metadata: schema.metadata,
			episode: schema.episodes,
			season: schema.seasons,
		})
		.from(schema.watchedHistory)
		.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
		.innerJoin(schema.metadata, metadataOn(schema.mediaFiles.metadataId))
		.leftJoin(schema.episodes, eq(schema.episodes.id, schema.mediaFiles.episodeId))
		.leftJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
		.where(where)
		// Honor the route's declared sortBy/sortOrder contract (audit 2026-09-15).
		// The id tiebreaker keeps offset pages deterministic for equal timestamps.
		.orderBy(...orderByFor(cursor, sortColumn, sortOrder))
		.limit(limit)
		.offset(cursor ? 0 : offset);

	// Backdrops batched for the page instead of one correlated subquery per row.
	const metadataIds = unique(rows, (row) => row.metadata.id);
	const backdropByMetadataId = new Map<string, typeof schema.images.$inferSelect | undefined>();
	if (metadataIds.length > 0) {
		const backdrops = await client
			.select({ metadataId: schema.metadataImages.metadataId, image: schema.images })
			.from(schema.metadataImages)
			.innerJoin(schema.images, metadataImageOn)
			.where(and(inArray(schema.metadataImages.metadataId, metadataIds), eq(schema.metadataImages.imageType, "backdrop")));
		for (const backdrop of backdrops) {
			if (!backdropByMetadataId.has(backdrop.metadataId)) backdropByMetadataId.set(backdrop.metadataId, backdrop.image);
		}
	}

	return rows.map((row) => ({ ...row, backdrop: backdropByMetadataId.get(row.metadata.id) ?? null }));
}

export async function findWatchedPage(
	profileId: string,
	query: CursorPaginationQuery & { sortBy?: "watchedAt" | "createdAt"; sortOrder?: "asc" | "desc" },
): Promise<CursorPaginatedResponse<WatchedHistoryWithRelations>> {
	const { pagination } = QueryUtils.parseStandard(query);
	const sortBy = query.sortBy ?? "watchedAt";
	const sortOrder = query.sortOrder ?? "desc";
	// Keyset pagination on the default listing (watchedAt desc) — offset pages
	// scan past all preceding joined rows, a cursor seeks straight to the key.
	const cursorMode = sortBy === "watchedAt" && sortOrder === "desc";
	const cursor = decodeCursorFor(query.cursor, cursorMode, "Pagination cursor requires descending watchedAt sorting");

	// The per-profile total only changes on history writes; caching it keeps the
	// COUNT scan out of every page request (the write paths clear this cache's
	// 10 s TTL via clearEtagBodyCache-driven invalidation of the HTTP body cache,
	// which the pagination total shares its staleness contract with).
	const countFilters = { profileId };
	const [total, rows] = await Promise.all([
		cachedCount("watchedHistory", filterSignature(countFilters, countFilters), () => countForProfile(profileId)),
		findWatchedWithMedia(profileId, { limit: pagination.limit, offset: pagination.offset, sortBy, sortOrder, cursor }),
	]);

	const response = QueryPagination.createResponse({
		total,
		pagination: cursor ? { ...pagination, page: 1, offset: 0 } : pagination,
		data: rows.map(({ history, metadata, episode, season, backdrop }) => ({ ...history, metadata, episode, season, backdrop })),
	});

	// The default listing is cursor mode, so the FIRST page must already carry
	// nextCursor — gating on the incoming cursor would starve it forever.
	if (!cursorMode || rows.length < pagination.limit) return response;

	const last = rows.at(-1);
	if (!last) return response;

	return { ...response, nextCursor: KeysetCursor.encode({ createdAt: last.history.watchedAt.getTime(), id: last.history.id }) };
}
