/**
 * `bun run seed [--rows 500]` — fills the configured database with a synthetic
 * catalog for local development (the same seeder the benchmark suites use).
 *
 * Only runs on a database without library data: the rows reference a fixed
 * `lib-bench` library and would collide with real data otherwise. Completed
 * setup is fine — the seeder never touches users or profiles.
 */

import { serverConfig } from "@/config/server/server.config";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { seedCatalog } from "./benchmarks/lib/seed.utils";

const DEFAULT_ROWS = 500;
const args = process.argv.slice(2);
const rowsIndex = args.indexOf("--rows");
const rows = rowsIndex === -1 ? DEFAULT_ROWS : Number.parseInt(args[rowsIndex + 1] ?? "", 10);

if (!Number.isInteger(rows) || rows <= 0) {
	console.error("--rows must be a positive integer");
	process.exit(2);
}

databaseFactory.migrate();

const existing = databaseFactory.sqlite
	.query("SELECT (SELECT COUNT(*) FROM libraries) + (SELECT COUNT(*) FROM media_files) AS total")
	.get();
const libraryRows = existing && typeof existing === "object" && "total" in existing ? Number(existing.total) : 0;

if (libraryRows > 0) {
	console.error(`${serverConfig.paths.sqlite} already contains library data — seed only runs on an empty database.`);
	process.exit(2);
}

const startedAt = performance.now();
const seedNow = seedCatalog(databaseFactory.sqlite, {
	rows,
	staggeredTimestamps: true,
	repositoryExtras: true,
});
databaseFactory.shutdown();

console.log(`Seeded ${rows} catalog rows (base timestamp ${seedNow}) in ${Math.round(performance.now() - startedAt)} ms.`);
