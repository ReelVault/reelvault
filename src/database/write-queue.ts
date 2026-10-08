import type { DatabaseType } from "./types";

/** Builder methods that execute a statement — every one must run under the lock. */
const EXECUTION_METHODS: ReadonlySet<string> = new Set(["then", "catch", "finally", "execute", "run", "all", "get"]);

/** Client methods that start a write (or a raw statement) and must be queued. */
const QUEUED_METHODS: ReadonlySet<string> = new Set(["insert", "update", "delete", "run"]);

/**
 * Wraps the main drizzle client so standalone writes queue on the transaction
 * lock instead of busy-waiting inside SQLite while the transaction connection
 * holds the write lock — that stall froze the event loop and surfaced as
 * `database is locked`. Reads pass through untouched.
 *
 * Drizzle write builders are chainable thenables: `db.insert(t)` returns a
 * builder whose `.values()` yields a second builder, and the statement runs when
 * the chain is awaited (`then`) or a terminal (`run`/`all`/`get`/`execute`) is
 * called. Every chain step therefore returns a proxy and every execution path
 * runs inside `runWrite`, so no repository can bypass the queue.
 */
export function createQueuedWriteClient(client: DatabaseType, runWrite: <T>(write: () => Promise<T>) => Promise<T>): DatabaseType {
	const queueBuilder = (builder: object): object =>
		new Proxy(builder, {
			get(target, property, receiver) {
				const value: unknown = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;

				return (...args: unknown[]) => {
					if (typeof property === "string" && EXECUTION_METHODS.has(property)) {
						return runWrite(async () => {
							const execution: unknown = value.apply(target, args);

							return await execution;
						});
					}

					const result: unknown = value.apply(target, args);
					if (result === target) {
						const sameBuilder: unknown = receiver;

						return sameBuilder;
					}

					if (result !== null && typeof result === "object") return queueBuilder(result);

					return result;
				};
			},
		});

	return new Proxy(client, {
		get(target, property, receiver) {
			if (typeof property !== "string" || !QUEUED_METHODS.has(property)) {
				const value: unknown = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;

				const bound: unknown = value.bind(target);

				return bound;
			}

			const original: unknown = Reflect.get(target, property, receiver);
			if (typeof original !== "function") return original;

			return (...args: unknown[]): unknown => {
				if (property === "run") {
					return runWrite(async () => {
						const execution: unknown = original.apply(target, args);

						return await execution;
					});
				}

				const result: unknown = original.apply(target, args);
				if (result === null || typeof result !== "object") return result;

				return queueBuilder(result);
			};
		},
	});
}
