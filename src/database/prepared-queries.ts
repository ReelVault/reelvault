import type { DatabaseTransaction } from "./types";

/**
 * Per-call-site prepared-statement factory (Faza 3 pilot).
 *
 * Returns a getter that builds the prepared query once per drizzle instance —
 * the main connection and the dedicated transaction connection are distinct
 * instances, so a prepared query is never shared across them. Each call site
 * owns one typed cache and the number of shapes is fixed, so the cache is
 * bounded by construction. Only fixed-SQL shapes belong here: dynamic
 * `$dynamic()` builders keep their current path.
 */
export function createPreparedQuery<TPrepared, TClient extends object = DatabaseTransaction>(
	build: (client: TClient) => TPrepared,
): (client: TClient) => TPrepared {
	const byClient = new WeakMap<object, TPrepared>();

	return (client: TClient): TPrepared => {
		let prepared = byClient.get(client);
		if (prepared === undefined) {
			prepared = build(client);
			byClient.set(client, prepared);
		}

		return prepared;
	};
}
