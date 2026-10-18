import { eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { pluginUiOverrides } from "@/integrations/drizzle-orm/schemas/plugin-ui-overrides.schema";

class PluginUiOverridesRepository {
	/** Hidden contribution keys per plugin. */
	async listAll(): Promise<Map<string, Set<string>>> {
		const rows = await databaseFactory.getClient().select().from(pluginUiOverrides);
		const byPlugin = new Map<string, Set<string>>();
		for (const row of rows) {
			const keys = byPlugin.get(row.pluginId);
			if (keys) keys.add(row.contributionKey);
			else byPlugin.set(row.pluginId, new Set([row.contributionKey]));
		}

		return byPlugin;
	}

	/** Replaces the whole hidden set of one plugin; an empty list clears it. */
	async replaceForPlugin(pluginId: string, keys: readonly string[]): Promise<void> {
		await databaseFactory.transaction(async (tx) => {
			await tx.delete(pluginUiOverrides).where(eq(pluginUiOverrides.pluginId, pluginId));
			if (keys.length === 0) return;

			await tx.insert(pluginUiOverrides).values(keys.map((contributionKey) => ({ pluginId, contributionKey })));
		});
	}
}

export const pluginUiOverridesRepository = new PluginUiOverridesRepository();
