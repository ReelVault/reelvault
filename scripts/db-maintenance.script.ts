/**
 * Database maintenance from the command line (stop the server first for `vacuum`):
 *
 *   bun run db:check                 PRAGMA quick_check — is the file structurally sound?
 *   bun run db:vacuum                rewrite the file to reclaim space, then PRAGMA optimize
 *   bun run db:backup [target.sqlite]  integrity check, then a consistent snapshot
 *                                    (default: <backups dir>/manual-<timestamp>.sqlite)
 */
import { mkdir } from "node:fs/promises";
import { serverConfig } from "@/config/server/server.config";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { getDirName, joinPath } from "@/utils/path.utils";

const [command, target] = process.argv.slice(2);

function quickCheck(): string[] {
	return databaseFactory.sqlite
		.query("PRAGMA quick_check")
		.values()
		.map((row) => String(row[0]));
}

function assertHealthy(): void {
	const problems = quickCheck().filter((line) => line !== "ok");
	if (problems.length > 0) {
		throw new Error(`Integrity check failed:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
	}
}

try {
	switch (command ?? "") {
		case "check":
			assertHealthy();
			console.log("Database integrity check passed.");
			break;
		case "vacuum":
			assertHealthy();
			databaseFactory.sqlite.run("VACUUM");
			databaseFactory.sqlite.run("PRAGMA optimize");
			console.log("Database vacuumed.");
			break;
		case "backup": {
			assertHealthy();
			const destination = target ?? joinPath(serverConfig.paths.backups, `manual-${new Date().toISOString().replaceAll(":", "-")}.sqlite`);
			await mkdir(getDirName(destination), { recursive: true });
			await databaseFactory.backup(destination);
			console.log(`Backup written to ${destination}`);
			break;
		}
		default:
			console.error("Usage: db-maintenance <check | vacuum | backup [target.sqlite]>");
			process.exitCode = 1;
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	databaseFactory.shutdown();
}
