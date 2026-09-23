import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Fixture, fixture } from "benchkit";
import { DatabaseFactory } from "@/database/database";

export interface BenchDb {
	factory: DatabaseFactory;
	/** Base timestamp the seeder used (rows derive their created_at from it). */
	seedNow: number;
}

export interface BenchDbOptions {
	/** Distinct temp-dir label per suite. */
	label: string;
	rows: number;
	/** The base timestamp the rows were seeded with (seedCatalog returns it). */
	seed: (db: Database) => number;
	/** Run ANALYZE right after seeding (planner statistics). */
	analyze: boolean;
}

/** Isolated migrated+seeded database in a temp dir; shutdown and rm happen in cleanup. */
export function benchDb(options: BenchDbOptions): Fixture<BenchDb> {
	return fixture("bench-db", async ({ onCleanup }) => {
		const rootDir = await mkdtemp(join(tmpdir(), `reelvault-benchmark-${options.label}-`));
		const factory = new DatabaseFactory(join(rootDir, "reelvault.sqlite"));
		onCleanup(async () => {
			factory.shutdown();
			await rm(rootDir, { recursive: true, force: true });
		});

		console.log(`[bench-db] ${options.label}: migrating and seeding ${options.rows} rows in ${rootDir}...`);
		factory.migrate();
		const seedNow = options.seed(factory.sqlite);
		if (options.analyze) factory.sqlite.run("ANALYZE");

		return { factory, seedNow };
	});
}
