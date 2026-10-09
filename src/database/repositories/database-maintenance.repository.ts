import { existsSync, readdirSync } from "node:fs";
import { databaseFactory, MIGRATIONS_DIR } from "@/database/database";
import { serverConstants } from "@/server.constants";
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

	/** Lets SQLite refresh its planner statistics (`PRAGMA optimize`). */
	optimize(): void {
		databaseFactory.sqlite.run("PRAGMA optimize");
	}
}

export const databaseMaintenanceRepository = new DatabaseMaintenanceRepository();
