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
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { defineRepository, defineTableAccess, findPageWithQueryMap, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFiltering } from "@/database/utils/filtering";
import type { QueryMap } from "@/database/utils/query-parser";
import { runInTransaction } from "@/database/utils/transaction";

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
