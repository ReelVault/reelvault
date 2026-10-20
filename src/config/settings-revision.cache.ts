import { systemSettingsStore } from "@/config/system-settings.store";

/**
 * Memoizes a value derived from the system-settings store.
 *
 * The store clones array and object values on every read, so identity
 * comparison cannot detect a change — the revision counter can. A memoized
 * value is therefore recomputed once per revision and reused until the next
 * one.
 */
export function revisionMemo<T>(compute: () => T): () => T {
	let cached: { revision: number; value: T } | undefined;

	return () => {
		const revision = systemSettingsStore.revision;
		if (!cached || cached.revision !== revision) {
			cached = { revision, value: compute() };
		}

		return cached.value;
	};
}
