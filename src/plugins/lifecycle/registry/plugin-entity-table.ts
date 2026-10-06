import { ValidationError } from "@/utils/errors";

export interface PluginEntityStatus {
	id: string;
	name: string;
	version: string;
	pluginId: string;
}

interface PluginEntityEntry<T> {
	/** Undefined while a plugin scope is still staging entities before its id is bound. */
	pluginId: string | undefined;
	entity: T;
}

/**
 * Id-keyed table of plugin-contributed entities (metadata providers, subtitle
 * providers, media analyzers) with per-plugin ownership, duplicate rejection
 * and memoized insertion-order views. A single owner of this bookkeeping keeps
 * the "registered by another plugin" diagnostics identical everywhere.
 */
export class PluginEntityTable<T extends { id: string; name: string; version: string }> {
	private readonly label: string;
	private readonly entries = new Map<string, PluginEntityEntry<T>>();
	private allCache: T[] | null = null;
	private statusCache: PluginEntityStatus[] | null = null;

	constructor(label: string) {
		this.label = label;
	}

	/** Pre-flight duplicate check so a multi-entity registration stays all-or-nothing. */
	assertRegisterable(entities: readonly T[]): void {
		for (const entity of entities) {
			const existing = this.entries.get(entity.id);
			if (existing) {
				throw new ValidationError(`${this.label} "${entity.id}" is already registered by plugin "${existing.pluginId ?? "unknown"}"`);
			}
		}
	}

	register(pluginId: string | undefined, entities: readonly T[]): void {
		for (const entity of entities) {
			if (!(entity.id && entity.name && entity.version)) {
				throw new ValidationError(`Plugin ${this.label} must have id, name and version`);
			}

			if (this.entries.has(entity.id)) {
				throw new ValidationError(`Plugin ${this.label} ${entity.id} is registered more than once`);
			}
		}

		for (const entity of entities) this.entries.set(entity.id, { pluginId, entity });

		this.invalidate();
	}

	removeForPlugin(pluginId: string): void {
		let removed = false;
		for (const [key, entry] of this.entries) {
			if (entry.pluginId !== pluginId) continue;

			this.entries.delete(key);
			removed = true;
		}

		if (removed) this.invalidate();
	}

	clear(): void {
		this.entries.clear();
		this.invalidate();
	}

	get(id: string): T | undefined {
		return this.entries.get(id)?.entity;
	}

	/** Insertion-ordered snapshot (memoized) — registration order is behavior for analyzers and search fan-out. */
	getAll(): T[] {
		this.allCache ??= [...this.entries.values()].map((entry) => entry.entity);

		return this.allCache;
	}

	getStatuses(): PluginEntityStatus[] {
		this.statusCache ??= [...this.entries.values()].map(({ pluginId, entity }) => ({
			id: entity.id,
			name: entity.name,
			version: entity.version,
			pluginId: pluginId ?? "unknown",
		}));

		return this.statusCache;
	}

	private invalidate(): void {
		this.allCache = null;
		this.statusCache = null;
	}
}
