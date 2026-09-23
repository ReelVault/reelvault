import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { env } from "@/env";
import { PathUtils } from "@/utils/path.utils";

const client = databaseFactory.getClient();

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
});
