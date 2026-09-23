import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export interface PluginBlobWriteOptions {
	contentType: string;
	expiresInMs: number;
}

export interface PluginBlobMetadata {
	key: string;
	contentType: string;
	size: number;
	createdAt: string;
	expiresAt: string;
}

export interface PluginBlob extends PluginBlobMetadata {
	content: Blob;
}

export interface PluginStorage {
	/**
	 * Returns the raw stored JSON-decoded value. Use {@link readStored} for a
	 * validated, typed read.
	 */
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	/**
	 * Serialized read-modify-write. The host locks per key, so concurrent updates
	 * cannot lose writes — no plugin-side locking needed. Use {@link updateStored}
	 * for a validated, typed variant.
	 */
	update(key: string, updater: (current: unknown) => unknown): Promise<unknown>;
	delete(key: string): Promise<void>;
	/** Keys of this plugin, optionally filtered by prefix (no values — cheap enumeration). */
	list(prefix?: string): Promise<string[]>;
	putBlob(key: string, content: Blob | Uint8Array, options: PluginBlobWriteOptions): Promise<PluginBlobMetadata>;
	getBlob(key: string): Promise<PluginBlob | undefined>;
	deleteBlob(key: string): Promise<void>;
}

/**
 * Typed, validated read. Returns `undefined` when the key is absent; throws when
 * the stored value does not match the schema (e.g. after an upgrade).
 */
export async function readStored<TValue extends TSchema>(
	storage: PluginStorage,
	key: string,
	schema: TValue,
): Promise<Static<TValue> | undefined> {
	const value = await storage.get(key);
	if (value === undefined) return undefined;

	return Value.Parse(schema, value);
}

/**
 * Typed, validated, atomic read-modify-write. The updater receives the parsed
 * current value (or `undefined`) and returns the next value; the host applies it
 * under a per-key lock and the result is validated before it is returned.
 */
export async function updateStored<TValue extends TSchema>(
	storage: PluginStorage,
	key: string,
	schema: TValue,
	updater: (current: Static<TValue> | undefined) => Static<TValue> | Promise<Static<TValue>>,
): Promise<Static<TValue>> {
	const next = await storage.update(key, async (current) => {
		const parsed = current === undefined ? undefined : Value.Parse(schema, current);

		return await updater(parsed);
	});

	return Value.Parse(schema, next);
}
