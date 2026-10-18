/**
 * Standalone schema migrator. Applies every pending migration from
 * `src/integrations/drizzle-orm/migrations` and exits — useful in CI/pre-deploy pipelines
 * where the server must not start until the schema is up to date.
 *
 * The server also runs this automatically at boot (`DatabaseFactory.migrate`),
 * so this script is optional for normal operation.
 */
import { MIGRATIONS_DIR } from "@/integrations/drizzle-orm/constants/migrations.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { createLogger } from "@/utils/logger.utils";

const logger = createLogger("Migrate");

try {
	logger.info("Applying database migrations", { migrationsFolder: MIGRATIONS_DIR });
	const { applied } = databaseFactory.migrate();
	logger.info("Database migrations applied", { appliedMigrations: applied });
	databaseFactory.shutdown();
} catch (error) {
	logger.error("Database migration failed", error);
	process.exit(1);
}
