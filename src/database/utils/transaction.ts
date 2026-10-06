import { databaseFactory } from "@/database/database";
import type { DatabaseTransaction } from "@/database/types";

/**
 * Runs `fn` on the caller's transaction when one is supplied, otherwise opens a
 * new top-level transaction. Repository methods that accept an optional `tx`
 * use this so a nested call joins the caller's transaction (savepoint) instead
 * of opening its own connection-level transaction.
 */
export async function runInTransaction<T>(tx: DatabaseTransaction | undefined, fn: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
	return tx ? await fn(tx) : await databaseFactory.transaction(fn);
}
