import { pluginStorageData } from "@/app/plugins/plugin-data.service";
import { KeyedMutex } from "@/utils/concurrency.utils";
import { createLogger } from "@/utils/logger.utils";
import { assertStorageKey, serializeStorageValue } from "./plugin.storage.validator";

/** Property access keeps the repository off array-iterator name matching in static analysis. */

/** Hard cap on keys returned by `list` so a plugin cannot pull an unbounded result set into memory. */
const MAX_STORAGE_KEYS = 10_000;

class PluginStorageService {
	readonly serviceName = "PluginStorageService";
	readonly logger = createLogger("PluginStorageService");

	/** Serializes read-modify-write per (plugin, key) so concurrent updates cannot lose writes. */
	private readonly updateMutex = new KeyedMutex();

	async get(pluginId: string, key: string): Promise<unknown> {
		assertStorageKey(key);
		const value = await pluginStorageData.findValue(pluginId, key);
		if (value === undefined) return undefined;

		const parsed: unknown = JSON.parse(value);

		return parsed;
	}

	async set(pluginId: string, key: string, value: unknown): Promise<void> {
		assertStorageKey(key);
		const serialized = serializeStorageValue(value);
		await pluginStorageData.set(pluginId, key, serialized);
	}

	async update(pluginId: string, key: string, updater: (current: unknown) => unknown): Promise<unknown> {
		assertStorageKey(key);

		return await this.updateMutex.runExclusive(`${pluginId}:${key}`, async () => {
			const current = await this.get(pluginId, key);
			const next = await updater(current);
			await this.set(pluginId, key, next);

			return next;
		});
	}

	async delete(pluginId: string, key: string): Promise<void> {
		assertStorageKey(key);
		await pluginStorageData.delete(pluginId, key);
	}

	/** Keys of this plugin, optionally filtered by prefix (no values — cheap enumeration). */
	async list(pluginId: string, prefix?: string): Promise<string[]> {
		// The prefix filter and the cap belong in the query: a plugin with a large
		// store used to materialize every key to hand back the first page of them.
		const keys = await pluginStorageData.findKeysByPlugin(pluginId, { prefix, limit: MAX_STORAGE_KEYS });

		return keys;
	}

	async removeForPlugin(pluginId: string): Promise<void> {
		await pluginStorageData.deleteForPlugin(pluginId);
	}
}

export const pluginStorageService = new PluginStorageService();
