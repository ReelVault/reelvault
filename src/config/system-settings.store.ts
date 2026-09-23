import { isRecord } from "@/utils/type.utils";
import { isSystemSettingKey, SYSTEM_SETTINGS, type SystemSettingKey, type SystemSettingValue } from "./system-settings.definition";
import type { SettingDefinition } from "./system-settings.types";

/**
 * Defaults/overrides may be arrays or objects. They are returned as shallow
 * copies so a caller mutating a setting value can never corrupt the shared
 * default (or the runtime override) for everyone else. Scalars pass through
 * unchanged — this is the hottest path (every serverConfig getter).
 */
function cloneSettingValue<T>(value: T): T;
function cloneSettingValue<K extends SystemSettingKey>(value: unknown, key: K): SystemSettingValue<K>;

function cloneSettingValue(value: unknown, _key?: SystemSettingKey): unknown {
	if (Array.isArray(value)) {
		const copy: unknown[] = value.map((item: unknown) => item);

		return copy;
	}

	if (isRecord(value)) return { ...value };

	return value;
}

class SystemSettingsStore {
	// Settings should not expire or be evicted by a size limit — this is not a "cache" in the TTL sense,
	// but a runtime-override layer on top of the hardcoded defaults.
	// A plain Map (instead of MemoryCache) keeps lookups allocation-free on the hottest path:
	// every serverConfig getter goes through get().
	private readonly runtime = new Map<SystemSettingKey, unknown>();

	private definition<K extends SystemSettingKey = SystemSettingKey>(key: string): SettingDefinition<SystemSettingValue<K>> {
		if (!isSystemSettingKey(key)) {
			throw new Error(`Unknown system setting key: ${key}`);
		}

		return SYSTEM_SETTINGS[key];
	}

	get<K extends SystemSettingKey>(key: K): SystemSettingValue<K>;
	get(key: string): unknown;
	get(key: string): unknown {
		const def = this.definition(key);
		if (this.runtime.size > 0 && isSystemSettingKey(key)) {
			const value = this.runtime.get(key);
			if (value !== undefined || this.runtime.has(key)) {
				return cloneSettingValue(value);
			}
		}

		return cloneSettingValue(def.default);
	}

	/**
	 * Returns the value along with metadata indicating whether it originates from a runtime override or the default.
	 * Single lookup instead of separate hasCustom() + get() calls at the call site.
	 */
	getWithMeta<K extends SystemSettingKey>(key: K): { value: SystemSettingValue<K>; isCustom: boolean } {
		const def = this.definition(key);
		if (this.runtime.size > 0) {
			const value = this.runtime.get(key);
			if (value !== undefined || this.runtime.has(key)) {
				return { value: cloneSettingValue(value, key), isCustom: true };
			}
		}

		return { value: cloneSettingValue(def.default), isCustom: false };
	}

	setRuntimeValue(key: SystemSettingKey, value: unknown): void {
		const def = this.definition(key);
		// Round-trip through the definition so the store can never hold an
		// invalidated value, even if a caller bypasses updateSettings().
		let raw: string;
		if (typeof value === "string") {
			raw = value;
		} else if (Array.isArray(value)) {
			raw = JSON.stringify(value);
		} else {
			raw = String(value);
		}

		this.runtime.set(key, def.parse(raw));
	}

	setRuntimeValues(values: Partial<Record<SystemSettingKey, unknown>>): void {
		for (const key of Object.keys(values)) {
			if (isSystemSettingKey(key)) {
				const value = values[key];
				if (value !== undefined) this.setRuntimeValue(key, value);
			}
		}
	}

	deleteRuntimeValues(keys: SystemSettingKey[]): void {
		for (const key of keys) {
			this.runtime.delete(key);
		}
	}

	clearRuntimeValues(): void {
		this.runtime.clear();
	}

	hasCustom(key: SystemSettingKey): boolean {
		return this.runtime.has(key);
	}
}

export const systemSettingsStore = new SystemSettingsStore();
