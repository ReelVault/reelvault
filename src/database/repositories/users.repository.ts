import type { FieldsConfig, SelectFields, User } from "@reelvault/sdk/common";
import { and, desc, eq, inArray, like, or, type SQL } from "drizzle-orm";
import { schema } from "@/database/schema";
import { defineTableAccess } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";

const users = defineTableAccess("users", {
	primaryKeyColumn: "id",
});

class UsersRepository {
	readonly table = schema.users;
	readonly primaryKeyColumn = users.primaryKeyColumn;
	readonly query = users.query;
	readonly selectMany = users.selectMany;
	readonly selectFirst = users.selectFirst;
	readonly findOrCreate = users.findOrCreate;
	readonly insert = users.insert;
	readonly update = users.update;
	readonly delete = users.delete;
	readonly count = users.count;
	readonly isExists = users.isExists;
	readonly insertReturning = users.insertReturning;
	readonly updateReturning = users.updateReturning;
	readonly updateAndReturn = users.updateAndReturn;
	readonly deleteReturning = users.deleteReturning;
	readonly deleteAndReturn = users.deleteAndReturn;
	readonly findByIds = users.findByIds;
	readonly findByColumnIn = users.findByColumnIn;

	async findByEmail(email: string): Promise<User | undefined> {
		return await this.findFirst({ where: eq(this.table.email, email) });
	}

	async findById(userId: string): Promise<User | undefined> {
		return await this.selectFirst({ where: eq(this.table.id, userId) });
	}

	async findForAdministration({ search, limit, offset }: { search?: string | undefined; limit: number; offset: number }) {
		const where = search ? or(like(this.table.name, `%${search}%`), like(this.table.email, `%${search}%`)) : undefined;
		const [total, data] = await Promise.all([
			this.count({ where }),
			this.selectMany({ where, orderBy: desc(this.table.createdAt), limit, offset }),
		]);

		return { total, data };
	}

	async countAdministrators(): Promise<number> {
		return await this.count({ where: eq(this.table.role, "admin") });
	}

	/** Role lookup for realtime fan-out — only admin ids among the given users. */
	async findAdminIdsByUserIds(userIds: readonly string[]): Promise<Set<string>> {
		if (userIds.length === 0) return new Set();

		const rows = await this.selectMany({ where: and(inArray(this.table.id, [...userIds]), eq(this.table.role, "admin")) });

		return new Set(rows.map((row) => row.id));
	}

	async promoteToAdmin(userId: string): Promise<void> {
		await this.update({ where: eq(this.table.id, userId), values: { role: "admin" } });
	}

	/**
	 * Get a single user by a custom WHERE clause, with optional field projection.
	 */
	async findFirst<F extends string>({
		fields,
		where,
		tx,
	}: {
		fields?: FieldsConfig<F> | undefined;
		where?: SQL | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<User, F> | undefined> {
		const role = await this.selectFirst({ where, tx });

		if (!role) return undefined;

		return QueryFields.apply(role, fields);
	}
}

export const usersRepository = new UsersRepository();
