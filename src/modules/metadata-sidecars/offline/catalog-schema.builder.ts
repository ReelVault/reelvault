import type { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { MIGRATIONS_DIR } from "@/integrations/drizzle-orm/constants/migrations.constants";
import { trimAndFilter } from "@/utils/array.utils";
import { FileUtils, readFile } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { PathUtils } from "@/utils/path.utils";

interface ServiceDependencies {
	migrationDirectory: () => string;
	listMigrationDirectories: (directory: string) => Promise<string[]>;
	readMigration: (migrationPath: string) => Promise<string>;
	migrationExists: (migrationPath: string) => Promise<boolean>;
}

const defaultDependencies: ServiceDependencies = {
	migrationDirectory: () => MIGRATIONS_DIR,
	listMigrationDirectories: async (directory) => {
		const entries = await readdir(directory, { withFileTypes: true });

		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.toSorted();
	},
	readMigration: (migrationPath) => readFile(migrationPath, "utf8"),
	migrationExists: (migrationPath) => FileUtils.exists(migrationPath),
};

/**
 * Replays the raw migration SQL into a fresh database, so the offline catalog
 * matches the schema the running server would migrate to.
 */
export class CatalogSchemaBuilder {
	readonly serviceName = "CatalogSchemaBuilder";
	readonly logger = createLogger("CatalogSchemaBuilder");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async createSchema(database: Database): Promise<void> {
		const migrationDirectory = this.dependencies.migrationDirectory();
		const migrationNames = await this.dependencies.listMigrationDirectories(migrationDirectory);
		for (const migration of migrationNames) {
			const migrationPath = PathUtils.join(migrationDirectory, migration, "migration.sql");
			if (!(await this.dependencies.migrationExists(migrationPath))) continue;

			const sql = await this.dependencies.readMigration(migrationPath);
			for (const statement of trimAndFilter(sql.split("--> statement-breakpoint"))) database.run(statement);
		}
	}
}
