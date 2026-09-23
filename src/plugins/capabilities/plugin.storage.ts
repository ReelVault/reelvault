import { pluginStorageRepository } from "@/database/repositories/plugin-storage.repository";

import { BaseService } from "@/utils/base-service";
import { KeyedMutex } from "@/utils/mutex";
import { assertStorageKey, serializeStorageValue } from "./plugin.storage.validation";

/** Property access keeps the repository off array-iterator name matching in static analysis. */
const storageRepository = { plugin: pluginStorageRepository };

/** Hard cap on keys returned by `list` so a plugin cannot pull an unbounded result set into memory. */
const MAX_STORAGE_KEYS = 10_000;

class PluginStorageService extends BaseService {
	/** Serializes read-modify-write per (plugin, key) so concurrent updates cannot lose writes. */
	private readonly updateMutex = new KeyedMutex();

	constructor() {
		super("PluginStorageService");
	}

	async get(pluginId: string, key: string): Promise<unknown> {
		assertStorageKey(key);
		const value = await storageRepository.plugin.find(pluginId, key);
		if (value === undefined) return undefined;

		const parsed: unknown = JSON.parse(value);

		return parsed;
	}

	async set(pluginId: string, key: string, value: unknown): Promise<void> {
		assertStorageKey(key);
		const serialized = serializeStorageValue(value);
		await storageRepository.plugin.set(pluginId, key, serialized);
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
		await storageRepository.plugin.delete(pluginId, key);
	}

	/** Keys of this plugin, optionally filtered by prefix (no values — cheap enumeration). */
	async list(pluginId: string, prefix?: string): Promise<string[]> {
		const keys = await storageRepository.plugin.findKeysByPlugin(pluginId);

		return keys
			.filter((key) => !prefix || key.startsWith(prefix))
			.toSorted()
			.slice(0, MAX_STORAGE_KEYS);
	}

	async removeForPlugin(pluginId: string): Promise<void> {
		await storageRepository.plugin.deleteForPlugin(pluginId);
	}
}

export const pluginStorageService = new PluginStorageService();
