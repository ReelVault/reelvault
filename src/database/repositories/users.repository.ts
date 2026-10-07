import type { SelectFields, User } from "@reelvault/sdk/common";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { defineRepository, defineTableAccess, mapChunked, selectFirstWithFields } from "@/database/table-access";
import { QueryFiltering } from "@/database/utils/filtering";
import type { FindFirstReadParams } from "@/database/utils/primary-id-read";

const users = defineTableAccess("users", {
	primaryKeyColumn: "id",
});

const overrides = {
	async findByEmail(email: string): Promise<User | undefined> {
		return await getUsersRepository().findFirst({ where: eq(users.table.email, email) });
	},

	async findById(userId: string): Promise<User | undefined> {
		return await getUsersRepository().selectFirst({ where: eq(users.table.id, userId) });
	},

	async findForAdministration({ search, limit, offset }: { search?: string | undefined; limit: number; offset: number }) {
		const where = search ? or(QueryFiltering.like(users.table.name, search), QueryFiltering.like(users.table.email, search)) : undefined;
		const [total, data] = await Promise.all([
			getUsersRepository().count({ where }),
			getUsersRepository().selectMany({ where, orderBy: desc(users.table.createdAt), limit, offset }),
		]);

		return { total, data };
	},

	async countAdministrators(): Promise<number> {
		return await getUsersRepository().count({ where: eq(users.table.role, "admin") });
	},

	async findAllAdministrators(): Promise<User[]> {
		return await getUsersRepository().selectMany({ where: eq(users.table.role, "admin") });
	},

	/** Role lookup for realtime fan-out — only admin ids among the given users. */
	async findAdminIdsByUserIds(userIds: readonly string[]): Promise<Set<string>> {
		if (userIds.length === 0) return new Set();

		// Chunked: the realtime fan-out passes one id per open connection, which can
		// exceed SQLite's per-statement variable limit on a busy instance.
		const rows = await mapChunked(
			[...userIds],
			async (idChunk) =>
				await getUsersRepository().selectMany({
					where: and(inArray(users.table.id, idChunk), eq(users.table.role, "admin")),
				}),
		);

		return new Set(rows.map((row) => row.id));
	},

	async promoteToAdmin(userId: string): Promise<void> {
		await getUsersRepository().update({ where: eq(users.table.id, userId), values: { role: "admin" } });
	},

	/**
	 * Get a single user by a custom WHERE clause, with optional field projection.
	 */
	async findFirst<F extends string>(params: FindFirstReadParams<F>): Promise<SelectFields<User, F> | undefined> {
		return await selectFirstWithFields(users, params);
	},
};

export const usersRepository = defineRepository(users, overrides);

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getUsersRepository() {
	return usersRepository;
}
