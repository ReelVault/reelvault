interface IdentityRow {
	stableKey: string;
}

interface IdentityRecoveryParams<T extends IdentityRow> {
	/** The stableKey the upsert targets. */
	stableKey: string;
	/** Insert-or-update by stableKey (`onConflictDoUpdate(...).returning()`). */
	upsert: () => Promise<T | undefined>;
	/** Lookup used when the upsert returned nothing. */
	findByStableKey: () => Promise<T | undefined>;
	/** Lookup by the row's natural identity (no stableKey involved). */
	findByIdentity: () => Promise<T | undefined>;
	/** Repairs a stale stableKey on an existing natural-identity row. */
	reconcile: (existing: T) => Promise<T | undefined>;
}

/**
 * Insert-or-update by `stableKey`, recovering from a stale stableKey.
 *
 * A unique conflict can only come from a natural-identity row whose stableKey
 * changed (the row was renamed/re-parented). In that case the row is located by
 * its natural identity and its stableKey is repaired, so callers never observe
 * a duplicate identity error.
 */
export async function findOrCreateWithIdentityRecovery<T extends IdentityRow>({
	stableKey,
	upsert,
	findByStableKey,
	findByIdentity,
	reconcile,
}: IdentityRecoveryParams<T>): Promise<T | undefined> {
	try {
		const row = await upsert();
		if (row) return row;

		return await findByStableKey();
	} catch {
		const existing = await findByIdentity();
		if (!existing) return await findByStableKey();

		return existing.stableKey === stableKey ? existing : await reconcile(existing);
	}
}
