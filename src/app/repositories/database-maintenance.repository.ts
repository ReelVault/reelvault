import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { serverConstants } from "@/config/server/server.constants";
import { MIGRATIONS_DIR } from "@/integrations/drizzle-orm/constants/migrations.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { PathUtils } from "@/utils/path.utils";

class DatabaseMaintenanceRepository {
	shutdownIfConfiguredDatabasePath(path: string) {
		if (PathUtils.resolve(path) === PathUtils.resolve(serverConstants.paths.sqlite)) databaseFactory.shutdown();
	}

	backup(targetPath: string): Promise<void> {
		return databaseFactory.backup(targetPath);
	}

	/** SQLite's quick consistency check: a healthy database answers a single `ok` row. */
	quickCheck(): string[] {
		return databaseFactory.sqlite
			.query<{ quick_check: string }, []>("PRAGMA quick_check")
			.all()
			.map((row) => row.quick_check);
	}

	/** Migration folders shipped with the server, in the order they apply, and how many the database has recorded as applied. */
	getMigrationStatus(): { tags: string[]; applied: number } {
		const tags = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(PathUtils.join(MIGRATIONS_DIR, entry.name, "migration.sql")))
			.map((entry) => entry.name)
			.toSorted();
		const row = databaseFactory.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM __drizzle_migrations").get();

		return { tags, applied: row?.count ?? 0 };
	}

	/**
	 * Checks an uploaded backup without touching the live database: it must open, pass SQLite's quick check and carry the
	 * migration journal that every ReelVault database has.
	 */
	verifyBackupFile(path: string): boolean {
		try {
			const db = new Database(path, { readonly: true });
			try {
				const checks = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
				const journal = db
					.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
					.get();

				return checks.length === 1 && checks[0]?.quick_check === "ok" && journal !== null;
			} finally {
				db.close();
			}
		} catch {
			return false;
		}
	}

	/** Lets SQLite refresh its planner statistics (`PRAGMA optimize`). */
	optimize(): void {
		databaseFactory.sqlite.run("PRAGMA optimize");
	}
}

export const databaseMaintenanceRepository = new DatabaseMaintenanceRepository();
