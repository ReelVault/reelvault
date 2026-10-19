import type { SelectFields, User } from "@reelvault/sdk/common";
import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { QueryFiltering } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { FindFirstReadParams } from "@/integrations/drizzle-orm/query/primary-id.reader";
import { mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { selectFirstWithFields } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

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

	async findForAdministration({
		search,
		role,
		banned,
		limit,
		offset,
	}: {
		search?: string | undefined;
		role?: "admin" | "user" | undefined;
		banned?: boolean | undefined;
		limit: number;
		offset: number;
	}) {
		let searchFilter: SQL | undefined;
		if (search) {
			searchFilter = or(QueryFiltering.like(users.table.name, search), QueryFiltering.like(users.table.email, search));
		}

		const where = and(
			searchFilter,
			role ? eq(users.table.role, role) : undefined,
			banned === undefined ? undefined : eq(users.table.banned, banned),
		);
		const [total, data] = await Promise.all([
			getUsersRepository().count({ where }),
			// created_at is second-resolution — the id tiebreaker keeps offset pages stable.
			getUsersRepository().selectMany({
				where,
				orderBy: sql`${desc(users.table.createdAt)}, ${desc(users.table.id)}`,
				limit,
				offset,
			}),
		]);

		return { total, data };
	},

	/** Whether any account exists — the first-run check needs a yes/no answer, not a total. */
	async hasAny(): Promise<boolean> {
		const [row] = await getUsersRepository().selectMany({ limit: 1 });

		return row !== undefined;
	},

	/** Administrators with a second factor enrolled: the accounts that can still sign in while enforcement is on. */
	async countAdministratorsWithTwoFactor(): Promise<number> {
		return await getUsersRepository().count({ where: and(eq(users.table.role, "admin"), eq(users.table.twoFactorEnabled, true)) });
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

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getUsersRepository() {
	return usersRepository;
}
