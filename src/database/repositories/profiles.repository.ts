import type { FieldsConfig, FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import type { CreateProfile, Profile, ProfileFilters, ProfileSorting } from "@sdk/common/profile.types";
import { and, desc, eq } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { ProjectedSelectParams } from "@/database/table-access";
import { defineTableAccess, findPageWithQueryMap, selectFirstWithFields, selectManyWithFields } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";
import { serverConfig } from "@/server.config";
import { MemoryCache } from "@/utils/memory-cache";

const profiles = defineTableAccess("profiles", {
	primaryKeyColumn: "id",
});

/**
 * Auth middleware resolves the active profile on every authenticated request;
 * a short TTL cache removes that DB round-trip from the hot path. Bounded by
 * profileCacheMaxEntries (LRU eviction). Profile mutations through this
 * repository drop the entry, so staleness is capped at profileCacheTtlMs
 * even for writes that bypass the service layer.
 */
const profileCache = new MemoryCache<Profile | null>({
	ttlMs: serverConfig.auth.profileCacheTtlMs,
	maxSize: serverConfig.auth.profileCacheMaxEntries,
	name: "profile",
});

function readProfileCached(profileId: string): Promise<Profile | undefined> {
	return profileCache
		.getOrSet(profileId, async () => {
			const profile = await profiles.findById({ primaryId: profileId });

			return profile ?? null;
		})
		.then((cached) => cached ?? undefined);
}

const profileQueryMap: QueryMap<ProfileFilters, ProfileSorting> = {
	filters: {
		userId: (value: string) => QueryFiltering.eq(schema.profiles.userId, value),
		name: (value: string) => QueryFiltering.like(schema.profiles.name, value),
	},
	orderBy: {
		name: schema.profiles.name,
		createdAt: schema.profiles.createdAt,
		updatedAt: schema.profiles.updatedAt,
	},
	defaults: { sortBy: "name", sortOrder: "asc" },
};

class ProfilesRepository {
	readonly table = schema.profiles;
	readonly primaryKeyColumn = profiles.primaryKeyColumn;
	readonly query = profiles.query;
	readonly selectMany = profiles.selectMany;
	readonly selectFirst = profiles.selectFirst;
	readonly findOrCreate = profiles.findOrCreate;
	readonly insert = profiles.insert;
	readonly update = profiles.update;
	readonly delete = profiles.delete;
	readonly count = profiles.count;
	readonly isExists = profiles.isExists;
	readonly insertReturning = profiles.insertReturning;
	readonly updateReturning = profiles.updateReturning;
	readonly updateAndReturn = profiles.updateAndReturn;
	readonly deleteReturning = profiles.deleteReturning;
	readonly deleteAndReturn = profiles.deleteAndReturn;
	readonly findByIds = profiles.findByIds;
	readonly findByColumnIn = profiles.findByColumnIn;

	async findMany<F extends string>({
		fields,
		where,
		orderBy,
		limit,
		offset,
		tx,
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<Profile, F>>> {
		const data = await selectManyWithFields(profiles, { where, orderBy, limit, offset, tx, fields });

		return data.map((item) => QueryFields.apply(item, fields));
	}

	/**
	 * Auth hot-path lookup (profile context for every authenticated request).
	 * Served from a short-TTL in-memory cache; mutations invalidate implicitly.
	 */
	async findByPrimaryIdCached(profileId: string): Promise<Profile | undefined> {
		return await readProfileCached(profileId);
	}

	/** Drops any cached auth-context copy of the profile (call after direct mutations). */
	invalidateCached(profileId: string): void {
		profileCache.delete(profileId);
	}

	async findByPrimaryId<F extends string>({
		primaryId,
		fields,
		tx,
	}: {
		primaryId: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<Profile, F> | undefined> {
		const person = await selectFirstWithFields(profiles, { where: eq(this.primaryKeyColumn, primaryId), tx, fields });

		if (!person) return undefined;

		return QueryFields.apply(person, fields);
	}

	async create<F extends string>({
		userId,
		body,
		fields,
		tx,
	}: {
		userId: string;
		body: CreateProfile;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<Profile, F> | undefined> {
		const [data] = await databaseFactory
			.getClient({ tx })
			.insert(this.table)
			.values({
				userId,
				name: body.name,
				avatarUrl: body.avatarUrl,
				pin: body.pin,
			})
			.returning();

		if (!data) return undefined;

		return QueryFields.apply(data, fields);
	}

	async isNameTaken({ userId, name }: { userId: string; name: string }): Promise<boolean> {
		return await this.isExists({ where: and(eq(this.table.userId, userId), eq(this.table.name, name)) });
	}

	async countByUserId(userId: string): Promise<number> {
		return await this.count({ where: eq(this.table.userId, userId) });
	}

	async findByUserId(userId: string): Promise<Profile[]> {
		return await this.selectMany({ where: eq(this.table.userId, userId), orderBy: desc(this.table.createdAt) });
	}

	async findByUserAndId(userId: string, profileId: string): Promise<Profile | undefined> {
		return await this.selectFirst({ where: and(eq(this.table.userId, userId), eq(this.table.id, profileId)) });
	}

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & ProfileFilters & ProfileSorting,
	): Promise<PaginatedResponse<SelectFields<Profile, F>>> {
		return await findPageWithQueryMap(profiles, profileQueryMap, query);
	}

	async createAndRead<F extends string>(
		userId: string,
		body: CreateProfile,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<Profile, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);

		return await this.create({ userId, body, fields });
	}

	async findByIdForRead<F extends string>(profileId: string, query?: FieldsQuery<F>): Promise<SelectFields<Profile, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);

		return await this.findByPrimaryId({ primaryId: profileId, fields });
	}

	async updateAndRead<F extends string>(
		profileId: string,
		values: Partial<typeof schema.profiles.$inferInsert>,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<Profile, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);
		profileCache.delete(profileId);

		return await profiles.updateAndReturn({ primaryId: profileId, values, fields });
	}

	async deleteOwned({ profileId, userId, tx }: { profileId: string; userId: string; tx?: DatabaseTransaction }): Promise<void> {
		await this.delete({ where: and(eq(this.table.userId, userId), eq(this.table.id, profileId)), tx });
		profileCache.delete(profileId);
	}
}

export const profilesRepository = new ProfilesRepository();
