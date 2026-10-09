import { databaseMaintenanceRepository } from "@/database/repositories/database-maintenance.repository";
import { BaseService } from "@/utils/base-service";

class DatabaseMaintenanceService extends BaseService {
	constructor() {
		super("DatabaseMaintenanceService");
	}

	/** Runs SQLite's quick check; `ok` only when it reports nothing but the healthy answer. */
	async checkIntegrity(): Promise<{ ok: boolean; messages: string[] }> {
		return await this.safeExecute("checkIntegrity", () => {
			const messages = databaseMaintenanceRepository.quickCheck();

			return { ok: messages.length === 1 && messages[0] === "ok", messages };
		});
	}

	async optimize(): Promise<{ success: true }> {
		return await this.safeExecute("optimize", () => {
			databaseMaintenanceRepository.optimize();
			this.logger.info("Database optimize finished");

			return { success: true as const };
		});
	}
}

export const databaseMaintenanceService = new DatabaseMaintenanceService();
