import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/database/database";
import { env } from "@/env";
import { PathUtils } from "@/utils/path.utils";

const client = databaseFactory.getClient();

const probe = sqliteTable("transaction_lock_probe", {
	id: integer("id").primaryKey(),
	value: text("value"),
});

/** Separate connection to the same file — simulates a concurrent writer. */
const concurrent = new Database(PathUtils.join(env.ROOT_DIR, env.DB_FILE_NAME));
concurrent.run("PRAGMA busy_timeout = 25");

beforeAll(async () => {
	await client.run(sql.raw("CREATE TABLE IF NOT EXISTS transaction_lock_probe (id INTEGER PRIMARY KEY, value TEXT)"));
});

afterAll(() => {
	concurrent.close();
});

describe("DatabaseFactory.transaction", () => {
	test("acquires the write lock up front so a read-then-write transaction cannot fail on upgrade", async () => {
		// Regression: with a deferred BEGIN this transaction reads a snapshot
		// first; a concurrent writer committing in between made SQLite refuse the
		// later write immediately with SQLITE_BUSY ("database is locked"), which
		// broke concurrent library scans. BEGIN IMMEDIATE holds the lock from the
		// start, so the other connection is the one that must wait/fail.
		let concurrentError: (Error & { code?: string }) | undefined;

		await databaseFactory.transaction(
			async (tx) => {
				await tx.run(sql`SELECT * FROM transaction_lock_probe`);

				try {
					concurrent.run("INSERT INTO transaction_lock_probe (value) VALUES ('concurrent')");
				} catch (error) {
					concurrentError = error as Error & { code?: string };
				}

				await tx.run(sql`INSERT INTO transaction_lock_probe (value) VALUES ('in-transaction')`);
			},
			{ immediate: true },
		);

		expect(concurrentError?.code).toBe("SQLITE_BUSY");

		// Once the transaction released the lock the concurrent writer succeeds.
		concurrent.run("INSERT INTO transaction_lock_probe (value) VALUES ('after')");
	});

	test("runWrite queues behind an open transaction instead of busy-waiting", async () => {
		const order: string[] = [];
		const transaction = databaseFactory.transaction(async () => {
			order.push("tx-start");
			await new Promise((resolve) => {
				setTimeout(resolve, 20);
			});
			order.push("tx-end");
		});
		const write = databaseFactory.runWrite(() => {
			order.push("write");

			return Promise.resolve();
		});

		await Promise.all([transaction, write]);

		expect(order).toEqual(["tx-start", "tx-end", "write"]);
	});

	test("queued client writes wait for an open transaction and then succeed", async () => {
		const order: string[] = [];
		const transaction = databaseFactory.transaction(async (tx) => {
			order.push("tx-start");
			await new Promise((resolve) => {
				setTimeout(resolve, 20);
			});
			await tx.run(sql`INSERT INTO transaction_lock_probe (value) VALUES ('in-transaction')`);
			order.push("tx-end");
		});
		const write = (async () => {
			await client.insert(probe).values({ value: "queued-write" });
			order.push("write-end");
		})();

		await Promise.all([transaction, write]);

		// The write waited for the transaction in JS and never hit SQLITE_BUSY.
		expect(order).toEqual(["tx-start", "tx-end", "write-end"]);
		const rows = await databaseFactory.getClient().select().from(probe).where(eq(probe.value, "queued-write"));
		expect(rows).toHaveLength(1);
	});

	test("a queued write behind a rolled-back transaction still succeeds", async () => {
		const transaction = databaseFactory
			.transaction(async (tx) => {
				await tx.run(sql`INSERT INTO transaction_lock_probe (value) VALUES ('rolled-back')`);
				throw new Error("boom");
			})
			.catch(() => undefined);
		const write = client.insert(probe).values({ value: "after-rollback" });

		await Promise.all([transaction, write]);

		const [rolledBack] = await databaseFactory.getClient().select().from(probe).where(eq(probe.value, "rolled-back"));
		expect(rolledBack).toBeUndefined();
		const [written] = await databaseFactory.getClient().select().from(probe).where(eq(probe.value, "after-rollback"));
		expect(written).toBeDefined();
	});

	test("runWrite inside a transaction runs inline instead of queueing on its own lock", async () => {
		const order: string[] = [];

		await databaseFactory.transaction(async () => {
			order.push("tx-start");
			await databaseFactory.runWrite(() => {
				order.push("inner-write");

				return Promise.resolve();
			});
			order.push("tx-end");
		});

		expect(order).toEqual(["tx-start", "inner-write", "tx-end"]);
	});

	test("nested runWrite calls and a transaction inside a queued write run inline", async () => {
		const order: string[] = [];

		await databaseFactory.runWrite(async () => {
			await databaseFactory.runWrite(() => {
				order.push("inner");

				return Promise.resolve();
			});
			await databaseFactory.transaction(async (tx) => {
				await tx.run(sql`SELECT 1`);
				order.push("transaction");
			});
			order.push("outer");
		});

		expect(order).toEqual(["inner", "transaction", "outer"]);
	});

	test("statements inside a transaction use the transaction connection", async () => {
		await databaseFactory.transaction(async (tx) => {
			await tx.run(sql`INSERT INTO transaction_lock_probe (value) VALUES ('own-write')`);

			// The ALS-aware client must see the transaction's own uncommitted write.
			const rows = await databaseFactory.getClient().select().from(probe).where(eq(probe.value, "own-write"));

			expect(rows).toHaveLength(1);
		});
	});
});
