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
import type { ProjectedSelectParams } from "@/database/table-access";
import { defineTableAccess, findPageWithQueryMap, mapChunked, selectManyWithFields } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import type { QueryMap } from "@/database/utils/query-parser";

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

class WatchlistRepository {
	readonly table = schema.watchlist;
	readonly primaryKeyColumn = watchlist.primaryKeyColumn;
	readonly query = watchlist.query;
	readonly selectMany = watchlist.selectMany;
	readonly selectFirst = watchlist.selectFirst;
	readonly findOrCreate = watchlist.findOrCreate;
	readonly insert = watchlist.insert;
	readonly update = watchlist.update;
	readonly delete = watchlist.delete;
	readonly count = watchlist.count;
	readonly isExists = watchlist.isExists;

	readonly insertReturning = watchlist.insertReturning;
	readonly updateReturning = watchlist.updateReturning;
	readonly updateAndReturn = watchlist.updateAndReturn;
	readonly deleteReturning = watchlist.deleteReturning;
	readonly deleteAndReturn = watchlist.deleteAndReturn;
	readonly findByIds = watchlist.findByIds;
	readonly findByColumnIn = watchlist.findByColumnIn;

	async findMany<F extends string>({
		fields,
		where,
		orderBy,
		limit,
		offset,
		tx,
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<Watchlist, F>>> {
		const data = await selectManyWithFields(watchlist, { where, orderBy, limit, offset, tx, fields });

		return data.map((item) => QueryFields.apply(item, fields));
	}

	async toggle({ profileId, metadataId, tx }: { profileId: string; metadataId: string; tx?: DatabaseTransaction }) {
		const run = async (client: ReturnType<typeof databaseFactory.getClient>) => {
			const deleted = await client
				.delete(this.table)
				.where(and(eq(this.table.profileId, profileId), eq(this.table.metadataId, metadataId)))
				.returning({ id: this.table.id });

			if (deleted.length > 0) {
				return { added: false };
			}

			await client.insert(this.table).values({ profileId, metadataId }).onConflictDoNothing();

			return { added: true };
		};

		return tx ? await run(tx) : await databaseFactory.transaction(run);
	}

	async remove(profileId: string, metadataId: string): Promise<void> {
		await this.delete({ where: and(eq(this.table.profileId, profileId), eq(this.table.metadataId, metadataId)) });
	}

	async isWatchlisted(profileId: string, metadataId: string): Promise<boolean> {
		return await this.isExists({ where: and(eq(this.table.profileId, profileId), eq(this.table.metadataId, metadataId)) });
	}

	/** Returns the subset of `metadataIds` that are on the profile's watchlist. */
	async findWatchlistedIds(profileId: string, metadataIds: readonly string[]): Promise<Set<string>> {
		if (metadataIds.length === 0) return new Set();

		const rows = await mapChunked([...metadataIds], (idChunk) =>
			databaseFactory
				.getClient()
				.select({ metadataId: this.table.metadataId })
				.from(this.table)
				.where(and(eq(this.table.profileId, profileId), inArray(this.table.metadataId, idChunk))),
		);

		return new Set(rows.map((row) => row.metadataId));
	}

	/** Profiles (with their owning user) that have this metadata row on their watchlist. */
	async findProfilesByMetadataId(metadataId: string): Promise<Array<{ profileId: string; userId: string }>> {
		return await databaseFactory
			.getClient()
			.select({ profileId: this.table.profileId, userId: schema.profiles.userId })
			.from(this.table)
			.innerJoin(schema.profiles, eq(schema.profiles.id, this.table.profileId))
			.where(eq(this.table.metadataId, metadataId));
	}

	async findPage<F extends string>(
		query: PaginationQuery & FieldsQuery<F> & WatchlistFilters & WatchlistSorting,
	): Promise<PaginatedResponse<SelectFields<Watchlist, F>>> {
		return await findPageWithQueryMap(watchlist, watchlistQueryMap, query);
	}
}

export const watchlistRepository = new WatchlistRepository();
