import { databaseMaintenanceRepository } from "@/app/repositories/database-maintenance.repository";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";

class DatabaseMaintenanceService {
	readonly serviceName = "DatabaseMaintenanceService";
	readonly logger = createLogger("DatabaseMaintenanceService");

	/** Runs SQLite's quick check; `ok` only when it reports nothing but the healthy answer. */
	async checkIntegrity(): Promise<{ ok: boolean; messages: string[] }> {
		return await runSafely(this, "checkIntegrity", () => {
			const messages = databaseMaintenanceRepository.quickCheck();

			return { ok: messages.length === 1 && messages[0] === "ok", messages };
		});
	}

	/** Migration folders shipped with this server and how many of them the database has applied. */
	async getMigrationStatus() {
		return await runSafely(this, "getMigrationStatus", () => {
			const { tags, applied } = databaseMaintenanceRepository.getMigrationStatus();
			const appliedCount = Math.min(applied, tags.length);

			return {
				total: tags.length,
				applied: appliedCount,
				pending: tags.length - appliedCount,
				latest: appliedCount > 0 ? (tags[appliedCount - 1] ?? null) : null,
				migrations: tags.map((tag, index) => ({ tag, applied: index < appliedCount })),
			};
		});
	}

	async optimize(): Promise<{ success: true }> {
		return await runSafely(this, "optimize", () => {
			databaseMaintenanceRepository.optimize();
			this.logger.info("Database optimize finished");

			return { success: true as const };
		});
	}
}

export const databaseMaintenanceService = new DatabaseMaintenanceService();
