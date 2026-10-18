import type {
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	Watchlist,
	WatchlistFilters,
	WatchlistSorting,
} from "@reelvault/sdk/common";
import { and, eq, inArray } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryFiltering } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { findPageWithQueryMap } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";

const watchlist = defineTableAccess("watchlist", {
	primaryKeyColumn: "id",
});

const watchlistQueryMap: QueryMap<WatchlistFilters, WatchlistSorting> = {
	filters: {
		profileId: (value: string) => QueryFiltering.eq(schema.watchlist.profileId, value),
		metadataId: (value: string) => QueryFiltering.eq(schema.watchlist.metadataId, value),
	},
	orderBy: {
		createdAt: schema.watchlist.createdAt,
		updatedAt: schema.watchlist.updatedAt,
	},
	defaults: { sortBy: "createdAt", sortOrder: "desc" },
};

const overrides = {
	async toggle({ profileId, metadataId, tx }: { profileId: string; metadataId: string; tx?: DatabaseTransaction }) {
		return await runInTransaction(tx, async (client) => {
			const deleted = await client
				.delete(watchlist.table)
				.where(and(eq(watchlist.table.profileId, profileId), eq(watchlist.table.metadataId, metadataId)))
				.returning({ id: watchlist.table.id });

			if (deleted.length > 0) {
				return { added: false };
			}

			await client.insert(watchlist.table).values({ profileId, metadataId }).onConflictDoNothing();

			return { added: true };
		});
	},

	async remove(profileId: string, metadataId: string): Promise<void> {
		await getWatchlistRepository().delete({
			where: and(eq(watchlist.table.profileId, profileId), eq(watchlist.table.metadataId, metadataId)),
		});
	},

	/** Adds the titles that are not on the watchlist yet; returns how many were added. */
	async insertMany(profileId: string, metadataIds: readonly string[]): Promise<number> {
		if (metadataIds.length === 0) return 0;

		const inserted = await databaseFactory
			.getClient()
			.insert(watchlist.table)
			.values(metadataIds.map((metadataId) => ({ profileId, metadataId })))
			.onConflictDoNothing()
			.returning({ id: watchlist.table.id });

		return inserted.length;
	},

	/** Removes the given titles from the watchlist; returns how many were removed. */
	async removeMany(profileId: string, metadataIds: readonly string[]): Promise<number> {
		if (metadataIds.length === 0) return 0;

		const removed = await mapChunked([...metadataIds], (idChunk) =>
			databaseFactory
				.getClient()
				.delete(watchlist.table)
				.where(and(eq(watchlist.table.profileId, profileId), inArray(watchlist.table.metadataId, idChunk)))
				.returning({ id: watchlist.table.id }),
		);

		return removed.length;
	},

	/** Empties the watchlist of one profile; returns how many titles were removed. */
	async clear(profileId: string): Promise<number> {
		const removed = await databaseFactory
			.getClient()
			.delete(watchlist.table)
			.where(eq(watchlist.table.profileId, profileId))
			.returning({ id: watchlist.table.id });

		return removed.length;
	},

	async isWatchlisted(profileId: string, metadataId: string): Promise<boolean> {
		return await getWatchlistRepository().isExists({
			where: and(eq(watchlist.table.profileId, profileId), eq(watchlist.table.metadataId, metadataId)),
		});
	},

	/** Returns the subset of `metadataIds` that are on the profile's watchlist. */
	async findWatchlistedIds(profileId: string, metadataIds: readonly string[]): Promise<Set<string>> {
		if (metadataIds.length === 0) return new Set();

		const rows = await mapChunked([...metadataIds], (idChunk) =>
			databaseFactory
				.getClient()
				.select({ metadataId: watchlist.table.metadataId })
				.from(watchlist.table)
				.where(and(eq(watchlist.table.profileId, profileId), inArray(watchlist.table.metadataId, idChunk))),
		);

		return new Set(rows.map((row) => row.metadataId));
	},

	/** Profiles (with their owning user) that have this metadata row on their watchlist. */
	async findProfilesByMetadataId(metadataId: string): Promise<Array<{ profileId: string; userId: string }>> {
		return await databaseFactory
			.getClient()
			.select({ profileId: watchlist.table.profileId, userId: schema.profiles.userId })
			.from(watchlist.table)
			.innerJoin(schema.profiles, eq(schema.profiles.id, watchlist.table.profileId))
			.where(eq(watchlist.table.metadataId, metadataId));
	},

	async findPage<F extends string>(
		query: PaginationQuery & FieldsQuery<F> & WatchlistFilters & WatchlistSorting,
	): Promise<PaginatedResponse<SelectFields<Watchlist, F>>> {
		return await findPageWithQueryMap({
			access: watchlist,
			queryMap: watchlistQueryMap,
			query,
			findMany: (params) => watchlist.findMany<F>(params),
		});
	},
};

export const watchlistRepository = defineRepository(watchlist, overrides);

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getWatchlistRepository() {
	return watchlistRepository;
}
