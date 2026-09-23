import { asc, eq } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { InternalError, NotFoundError } from "@/utils/errors";

class PluginRepositoriesRepository {
	readonly table = schema.pluginRepositories;

	async list() {
		return await databaseFactory.getClient().select().from(this.table).orderBy(asc(this.table.createdAt));
	}

	async findById(id: string) {
		const [entry] = await databaseFactory.getClient().select().from(this.table).where(eq(this.table.id, id)).limit(1);

		return entry;
	}

	async count(): Promise<number> {
		const rows = await databaseFactory.getClient().select({ id: this.table.id }).from(this.table).limit(1);

		return rows.length;
	}

	async create(values: { name: string; url: string; tokenEncrypted?: string | null; enabled?: boolean }) {
		const [entry] = await databaseFactory
			.getClient()
			.insert(this.table)
			.values({
				name: values.name,
				url: values.url,
				tokenEncrypted: values.tokenEncrypted ?? null,
				enabled: values.enabled ?? true,
			})
			.returning();
		if (!entry) throw new InternalError("Plugin repository insert returned no row");

		return entry;
	}

	async update(
		id: string,
		values: Partial<{
			name: string;
			url: string;
			tokenEncrypted: string | null;
			enabled: boolean;
			lastRefreshedAt: Date | null;
			lastError: string | null;
		}>,
	) {
		const [entry] = await databaseFactory
			.getClient()
			.update(this.table)
			.set({ ...values, updatedAt: new Date() })
			.where(eq(this.table.id, id))
			.returning();
		if (!entry) throw new NotFoundError(`Plugin repository not found: ${id}`);

		return entry;
	}

	async delete(id: string): Promise<void> {
		await databaseFactory.getClient().delete(this.table).where(eq(this.table.id, id));
	}
}

export const pluginRepositoriesRepository = new PluginRepositoriesRepository();
