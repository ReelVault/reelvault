import { databaseFactory } from "@/database/database";
import { serverConfig } from "@/server.config";
import { PathUtils } from "@/utils/path.utils";

class DatabaseMaintenanceRepository {
	shutdownIfConfiguredDatabasePath(path: string) {
		if (PathUtils.resolve(path) === PathUtils.resolve(serverConfig.paths.sqlite)) databaseFactory.shutdown();
	}

	backup(targetPath: string): Promise<void> {
		return databaseFactory.backup(targetPath);
	}
}

export const databaseMaintenanceRepository = new DatabaseMaintenanceRepository();
