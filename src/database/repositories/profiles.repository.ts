import type {
	CreateProfile,
	FieldsConfig,
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	Profile,
	ProfileFilters,
	ProfileSorting,
	SelectFields,
} from "@reelvault/sdk/common";
import { and, desc, eq, ne } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { defineRepository, defineTableAccess, findPageWithQueryMap, parseFieldsForRead } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import { type PrimaryIdReadParams, selectByIdWithFields } from "@/database/utils/primary-id-read";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";
import { serverConstants } from "@/server.constants";
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
	ttlMs: serverConstants.auth.profileCacheTtlMs,
	maxSize: serverConstants.auth.profileCacheMaxEntries,
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

const overrides = {
	/**
	 * Auth hot-path lookup (profile context for every authenticated request).
	 * Served from a short-TTL in-memory cache; mutations invalidate implicitly.
	 */
	async findByPrimaryIdCached(profileId: string): Promise<Profile | undefined> {
		return await readProfileCached(profileId);
	},

	/** Drops any cached auth-context copy of the profile (call after direct mutations). */
	invalidateCached(profileId: string): void {
		profileCache.delete(profileId);
	},

	async findByPrimaryId<F extends string>(params: PrimaryIdReadParams<F>): Promise<SelectFields<Profile, F> | undefined> {
		return await selectByIdWithFields(profiles, params);
	},

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
			.insert(profiles.table)
			.values({
				userId,
				name: body.name,
				avatarUrl: body.avatarUrl,
				pin: body.pin,
			})
			.returning();

		if (!data) return undefined;

		return QueryFields.apply(data, fields);
	},

	async isNameTaken({ userId, name, excludeId }: { userId: string; name: string; excludeId?: string }): Promise<boolean> {
		return await getProfilesRepository().isExists({
			where: and(
				eq(profiles.table.userId, userId),
				eq(profiles.table.name, name),
				excludeId ? ne(profiles.table.id, excludeId) : undefined,
			),
		});
	},

	async countByUserId(userId: string): Promise<number> {
		return await getProfilesRepository().count({ where: eq(profiles.table.userId, userId) });
	},

	async findByUserId(userId: string): Promise<Profile[]> {
		return await getProfilesRepository().selectMany({ where: eq(profiles.table.userId, userId), orderBy: desc(profiles.table.createdAt) });
	},

	async findByUserAndId(userId: string, profileId: string): Promise<Profile | undefined> {
		return await getProfilesRepository().selectFirst({
			where: and(eq(profiles.table.userId, userId), eq(profiles.table.id, profileId)),
		});
	},

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & ProfileFilters & ProfileSorting,
	): Promise<PaginatedResponse<SelectFields<Profile, F>>> {
		return await findPageWithQueryMap({
			access: profiles,
			queryMap: profileQueryMap,
			query,
			findMany: (params) => profiles.findMany<F>(params),
		});
	},

	async createAndRead<F extends string>(
		userId: string,
		body: CreateProfile,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<Profile, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);

		return await getProfilesRepository().create({ userId, body, fields });
	},

	async findByIdForRead<F extends string>(profileId: string, query?: FieldsQuery<F>): Promise<SelectFields<Profile, F> | undefined> {
		return await getProfilesRepository().findByPrimaryId({ primaryId: profileId, fields: parseFieldsForRead(query) });
	},

	async updateAndRead<F extends string>(
		profileId: string,
		values: Partial<typeof schema.profiles.$inferInsert>,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<Profile, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);
		profileCache.delete(profileId);

		return await profiles.updateAndReturn({ primaryId: profileId, values, fields });
	},

	async deleteOwned({ profileId, userId, tx }: { profileId: string; userId: string; tx?: DatabaseTransaction }): Promise<void> {
		await getProfilesRepository().delete({
			where: and(eq(profiles.table.userId, userId), eq(profiles.table.id, profileId)),
			tx,
		});
		profileCache.delete(profileId);
	},
};

export const profilesRepository = defineRepository(profiles, overrides);

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getProfilesRepository() {
	return profilesRepository;
}
