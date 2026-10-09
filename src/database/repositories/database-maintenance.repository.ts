import { databaseFactory } from "@/database/database";
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

	/** Lets SQLite refresh its planner statistics (`PRAGMA optimize`). */
	optimize(): void {
		databaseFactory.sqlite.run("PRAGMA optimize");
	}
}

export const databaseMaintenanceRepository = new DatabaseMaintenanceRepository();
