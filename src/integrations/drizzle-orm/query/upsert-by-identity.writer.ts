import { eq, type SQL } from "drizzle-orm";
import type { DatabaseTables, DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { DomainError } from "@/utils/domain.errors";
import type { TableAccess, TableInsertValue, TableSelect, TableUpdateSet } from "./table-access/table-access.types";

/** Tables whose rows carry both a primary `id` and a `stableKey`. */
type StableKeyTable = {
	[K in DatabaseTables]: TableSelect<K> extends { id: string; stableKey: string } ? K : never;
}[DatabaseTables];

interface IdentityRecoveryParams<T> {
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
	/** Reads the current stableKey off a row. */
	stableKeyOf: (row: T) => string;
}

/**
 * Insert-or-update by `stableKey`, recovering from a stale stableKey.
 *
 * A unique conflict can only come from a natural-identity row whose stableKey
 * changed (the row was renamed/re-parented). In that case the row is located by
 * its natural identity and its stableKey is repaired, so callers never observe
 * a duplicate identity error.
 */
export async function findOrCreateWithIdentityRecovery<T>({
	stableKey,
	upsert,
	findByStableKey,
	findByIdentity,
	reconcile,
	stableKeyOf,
}: IdentityRecoveryParams<T>): Promise<T | undefined> {
	try {
		const row = await upsert();
		if (row) return row;

		return await findByStableKey();
	} catch {
		const existing = await findByIdentity();
		if (!existing) return await findByStableKey();

		if (stableKeyOf(existing) === stableKey) return existing;

		return await reconcile(existing);
	}
}

/**
 * The whole stable-key identity write in one call: insert-or-update by
 * `stableKey`, recover when the natural-identity row carries a stale key, and
 * repair that key. Callers keep only their values and natural-identity
 * condition.
 */
export async function upsertByStableKeyIdentity<TTable extends StableKeyTable>(
	access: TableAccess<TTable>,
	{
		stableKey,
		values,
		identityWhere,
		set,
		setWhere,
		reconcileValues,
		tx,
	}: {
		stableKey: string;
		values: TableInsertValue<TTable> & { stableKey: string };
		identityWhere: SQL | undefined;
		set?: TableUpdateSet<TTable> | "inserted" | undefined;
		setWhere?: SQL | undefined;
		/** Columns repaired together with a stale stableKey; must include the new key. */
		reconcileValues: TableUpdateSet<TTable>;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<TableSelect<TTable> | undefined> {
	if (!identityWhere)
		throw new DomainError("internal", `${access.tableName}: stable-key upsert requires an identity condition`, {
			code: "table_access.identity_condition_missing",
		});

	return await findOrCreateWithIdentityRecovery({
		stableKey,
		upsert: async () => {
			const [row] = await access.upsert({
				values,
				target: access.table.stableKey,
				set,
				setWhere,
				returning: true,
				tx,
			});

			return row;
		},
		findByStableKey: async () => await access.selectFirst({ where: eq(access.table.stableKey, stableKey), tx }),
		findByIdentity: async () => await access.selectFirst({ where: identityWhere, tx }),
		reconcile: async (existing) => {
			// `updateReturning` stamps `updatedAt` through the shared update path.
			const [updated] = await access.updateReturning({
				primaryId: existing.id,
				values: reconcileValues,
				tx,
			});

			return updated ?? existing;
		},
		stableKeyOf: (row) => row.stableKey,
	});
}
