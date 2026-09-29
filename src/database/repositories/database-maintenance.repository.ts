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
}

export const databaseMaintenanceRepository = new DatabaseMaintenanceRepository();
