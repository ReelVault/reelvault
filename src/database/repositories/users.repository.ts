import type { SelectFields, User } from "@reelvault/sdk/common";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { defineRepository, defineTableAccess, selectFirstWithFields } from "@/database/table-access";
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
		const where = search ? or(like(users.table.name, `%${search}%`), like(users.table.email, `%${search}%`)) : undefined;
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

		const rows = await getUsersRepository().selectMany({
			where: and(inArray(users.table.id, [...userIds]), eq(users.table.role, "admin")),
		});

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
