import { asc, eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { DomainError } from "@/utils/domain.errors";

export const pluginRepositoriesRepository = {
	table: schema.pluginRepositories,

	async list() {
		return await databaseFactory
			.getClient()
			.select()
			.from(pluginRepositoriesRepository.table)
			.orderBy(asc(pluginRepositoriesRepository.table.createdAt));
	},

	async findById(id: string) {
		const [entry] = await databaseFactory
			.getClient()
			.select()
			.from(pluginRepositoriesRepository.table)
			.where(eq(pluginRepositoriesRepository.table.id, id))
			.limit(1);

		return entry;
	},

	async count(): Promise<number> {
		return await databaseFactory.getClient().$count(pluginRepositoriesRepository.table);
	},

	async create(values: { name: string; url: string; tokenEncrypted?: string | null; enabled?: boolean }) {
		const [entry] = await databaseFactory
			.getClient()
			.insert(pluginRepositoriesRepository.table)
			.values({
				name: values.name,
				url: values.url,
				tokenEncrypted: values.tokenEncrypted ?? null,
				enabled: values.enabled ?? true,
			})
			.returning();
		if (!entry) throw new DomainError("internal", "Plugin repository insert returned no row", { code: "plugin.repository_save_failed" });

		return entry;
	},

	/**
	 * Idempotent seed: inserts only when the URL is not present yet. Unlike
	 * `create`, a concurrent duplicate (unique `url`) is a no-op instead of a
	 * constraint error — used for the built-in official repository, which two
	 * parallel first requests used to race into a 500.
	 */
	async createIfAbsent(values: { name: string; url: string }): Promise<void> {
		await databaseFactory
			.getClient()
			.insert(pluginRepositoriesRepository.table)
			.values({ name: values.name, url: values.url, tokenEncrypted: null, enabled: true })
			.onConflictDoNothing();
	},

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
			.update(pluginRepositoriesRepository.table)
			.set({ ...values, updatedAt: new Date() })
			.where(eq(pluginRepositoriesRepository.table.id, id))
			.returning();
		if (!entry) throw new DomainError("not_found", `Plugin repository not found: ${id}`, { code: "plugin.repository_not_found" });

		return entry;
	},

	async delete(id: string): Promise<void> {
		await databaseFactory.getClient().delete(pluginRepositoriesRepository.table).where(eq(pluginRepositoriesRepository.table.id, id));
	},
};
