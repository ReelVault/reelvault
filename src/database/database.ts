import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as runMigrations } from "drizzle-orm/bun-sqlite/migrator";
import { env } from "@/env";
import { clamp } from "@/utils/math.utils";
import { getTotalMemoryKiB } from "@/utils/mem.utils";
import { PathUtils } from "@/utils/path.utils";
import { isRecord } from "@/utils/type.utils";
import { DatabaseQueryLogger, instrumentSqliteClient } from "./query-logger";
import { relations } from "./relations";
import type { DatabaseTransaction, DatabaseType } from "./types";

/** Migration folders ship next to this module (`src/database/migrations`). */
export const MIGRATIONS_DIR = PathUtils.join(import.meta.dir, "migrations");

const queryLogger = new DatabaseQueryLogger({
	// Dev always logs; production opts in via APP_SLOW_QUERY_LOG=true while
	// diagnosing storage slowness (warn level, ≥100 ms statements only).
	enabled: env.NODE_ENV === "development" || env.APP_SLOW_QUERY_LOG === "true",
	slowThresholdMs: 100,
});

interface TransactionContext {
	depth: number;
}

export class DatabaseFactory {
	public readonly sqlite: Database;
	public readonly db: DatabaseType;
	/**
	 * Dedicated connection for top-level transactions. SQLite allows a single
	 * writer: keeping transactions on their own connection prevents plain
	 * statements from unrelated tasks from interleaving into an open transaction
	 * (previously their writes were silently rolled back with it). WAL lets the
	 * main connection keep reading while a transaction holds the write lock.
	 */
	private readonly path: string;
	private txSqlite: Database | null = null;
	private txDb: DatabaseType | null = null;
	private readonly als = new AsyncLocalStorage<TransactionContext>();
	private transactionLock: Promise<void> = Promise.resolve();

	constructor(path = PathUtils.join(env.ROOT_DIR, env.DB_FILE_NAME)) {
		this.path = path;
		// With secrets provided via env, nothing else creates ROOT_DIR before this
		// constructor runs at import time — a missing directory would surface as a
		// raw SQLITE_CANTOPEN crash instead of a boot-time recovery.
		mkdirSync(PathUtils.getDirName(path), { recursive: true });
		this.sqlite = new Database(path);
		this.configureConnection(this.sqlite);
		this.db = drizzle({ client: instrumentSqliteClient(this.sqlite, queryLogger), relations, logger: queryLogger });
	}

	/**
	 * Applies every pending migration from `src/database/migrations`. Drizzle
	 * records applied migrations in `__drizzle_migrations`, so this is
	 * idempotent and safe to call on every boot. Must run before any repository
	 * touches the schema (the server calls it first in `setupServer`).
	 *
	 * Returns the total number of migrations recorded as applied.
	 */
	migrate(migrationsFolder = MIGRATIONS_DIR): { applied: number } {
		if (!existsSync(migrationsFolder)) {
			throw new Error(`Migrations directory not found: ${migrationsFolder}`);
		}

		runMigrations(this.db, { migrationsFolder });
		this.analyzeIfStatisticsMissing();

		return { applied: this.countAppliedMigrations() };
	}

	/**
	 * Without `sqlite_stat1` the planner guesses, and on the paginated browse
	 * path it guessed wrong: it picked `metadata_type_title_idx` and sorted the
	 * whole result with a TEMP B-TREE instead of walking `metadata_title_id_idx`
	 * (measured 0.14 ms vs 0.04 ms at 5k rows, and the gap grows with the
	 * catalog). Existing databases predate the composite indexes, so give them
	 * statistics once; fresh databases are analyzed after seeding by the callers
	 * that write bulk data. `PRAGMA optimize` on shutdown keeps them fresh.
	 */
	/**
	 * Refreshes planner statistics after a bulk write (e.g. a finished library
	 * scan). Both connections are analyzed: bun:sqlite caches prepared statements
	 * per connection, and ANALYZE on one connection does not make the other
	 * re-plan, so a stale plan on the transaction connection would otherwise
	 * persist (observed as worker-claim cost growing with backlog).
	 */
	analyze(): void {
		this.sqlite.run("ANALYZE");
		this.txSqlite?.run("ANALYZE");
	}

	private analyzeIfStatisticsMissing(): void {
		const stats = this.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get();
		if (stats) return;

		this.sqlite.run("ANALYZE");
	}

	private countAppliedMigrations(): number {
		try {
			const row: unknown = this.sqlite.query("SELECT count(*) AS count FROM __drizzle_migrations").get();
			if (!isRecord(row) || typeof row.count !== "number") return 0;

			return row.count;
		} catch {
			// No migrations folder content means the ledger was never created.
			return 0;
		}
	}

	getClient({ tx }: { tx?: DatabaseTransaction | undefined } = {}): DatabaseTransaction {
		return tx ?? this.db;
	}

	private getTransactionClient(): Database {
		if (!this.txSqlite) {
			this.txSqlite = new Database(this.path);
			this.configureConnection(this.txSqlite);
		}

		return this.txSqlite;
	}

	private getTransactionDrizzle(): DatabaseType {
		const client = this.getTransactionClient();
		this.txDb ??= drizzle({ client: instrumentSqliteClient(client, queryLogger), relations, logger: queryLogger });

		return this.txDb;
	}

	async transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>, options: { immediate?: boolean } = {}): Promise<T> {
		const currentStore = this.als.getStore();

		if (currentStore) {
			const depth = currentStore.depth + 1;
			const savepoint = `sp_${depth}`;
			const txClient = this.getTransactionClient();
			txClient.run(`SAVEPOINT ${savepoint}`);

			try {
				const result = await this.als.run({ depth }, () => callback(this.getTransactionDrizzle()));
				txClient.run(`RELEASE SAVEPOINT ${savepoint}`);

				return result;
			} catch (error) {
				try {
					txClient.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
					txClient.run(`RELEASE SAVEPOINT ${savepoint}`);
				} catch {
					// Savepoint may have been invalidated by SQLite
				}

				throw error;
			}
		}

		const previousLock = this.transactionLock;
		let releaseLock!: () => void;
		this.transactionLock = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});

		await previousLock;
		const txClient = this.getTransactionClient();

		try {
			// `immediate` takes the write lock up front so busy_timeout can wait for
			// it. Use it for write-heavy transactions whose statements all pass the
			// transaction client explicitly: a deferred BEGIN only locks on the
			// first write, and SQLite refuses to upgrade a transaction that already
			// read a snapshot once another connection wrote — failing immediately
			// with SQLITE_BUSY_SNAPSHOT (this broke concurrent library scans).
			// It is opt-in because some repositories still write through the main
			// connection inside a transaction (getClient ignores the ALS store),
			// and an immediate lock would make those writes wait on themselves.
			txClient.run(options.immediate ? "BEGIN IMMEDIATE" : "BEGIN");
			try {
				const result = await this.als.run({ depth: 1 }, () => callback(this.getTransactionDrizzle()));
				txClient.run("COMMIT");

				return result;
			} catch (error) {
				try {
					txClient.run("ROLLBACK");
				} catch {
					// Transaction may have already been rolled back by SQLite
				}

				throw error;
			}
		} finally {
			releaseLock();
		}
	}

	/**
	 * Runs `VACUUM INTO` in a short-lived child process on its own connection.
	 * bun:sqlite is synchronous on the calling thread, so doing this in-process
	 * froze the whole event loop (playback included) for the entire DB rewrite.
	 */
	async backup(targetPath: string): Promise<void> {
		const escapedTarget = targetPath.replaceAll("'", "''");
		const script = [
			'import { Database } from "bun:sqlite";',
			`const db = new Database(${JSON.stringify(this.path)});`,
			"try {",
			'	db.run("PRAGMA busy_timeout = 15000");',
			`	db.run(${JSON.stringify(`VACUUM INTO '${escapedTarget}'`)});`,
			"} finally {",
			"	db.close();",
			"}",
		].join("\n");

		const proc = Bun.spawn({
			cmd: [process.execPath, "-e", script],
			stdout: "ignore",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		if (exitCode !== 0) {
			throw new Error(`Database backup failed (exit ${exitCode}): ${stderr.trim()}`);
		}
	}

	shutdown() {
		try {
			// SQLite's recommended shutdown hook: refreshes statistics for tables
			// whose data changed enough to make the current stats misleading.
			this.sqlite.run("PRAGMA optimize");
		} catch {
			// Never block shutdown on an optimization failure.
		}

		this.sqlite.close();
		this.txSqlite?.close();
	}

	private configureConnection(connection: Database) {
		connection.run("PRAGMA foreign_keys = ON");
		connection.run("PRAGMA journal_mode = WAL");
		connection.run("PRAGMA synchronous = NORMAL");
		connection.run("PRAGMA busy_timeout = 5000");
		// Page cache scales with the machine: ~1.25% of RAM, 16-128 MiB per
		// connection (2 MiB read of /proc/meminfo is not needed — MemTotal only).
		connection.run(`PRAGMA cache_size = -${this.resolvePageCacheKiB()}`);
		connection.run("PRAGMA mmap_size = 268435456");
		connection.run("PRAGMA temp_store = MEMORY");
		connection.run("PRAGMA wal_autocheckpoint = 1000");
		// Bound the -wal file after checkpoints during long write bursts
		// (e.g. thousand-file library ingests).
		connection.run("PRAGMA journal_size_limit = 67108864");
	}

	/** 1.25% of total RAM in KiB, clamped to 16-128 MiB (per connection). */
	private resolvePageCacheKiB(): number {
		const minKiB = 16 * 1024;
		const maxKiB = 128 * 1024;
		const totalKiB = getTotalMemoryKiB();
		if (!totalKiB) return maxKiB;

		return clamp(Math.floor(totalKiB * 0.0125), minKiB, maxKiB);
	}
}

export const databaseFactory = new DatabaseFactory();
