/**
 * Statement-count audit.
 *
 * Measures how many SQL statements each hot operation executes on an isolated,
 * migrated and seeded database. The point is not timing (the query logger
 * instruments statements with a Proxy, which distorts micro-timings) but the
 * query count: SQLite is synchronous on one connection, so statement count is
 * the latency currency. Each case carries the target the optimization work must
 * reach; `--strict` fails the run while any target is exceeded.
 *
 * Usage:
 *   bun run scripts/benchmark.ts query-count [--rows 5000]
 *
 * Add new cases here when an optimization lands; extend the shared seeder
 * (lib/seed.ts) instead of inlining seed SQL.
 */

import { main, printTable, suiteArgs, task } from "benchkit";
import { seedCatalog } from "./lib/seed";

// Statement counting must be enabled before the ambient factory is constructed,
// and static imports are hoisted — so the database module is imported dynamically.
// The repositories resolve `databaseFactory` from this same module instance.
process.env.APP_SLOW_QUERY_LOG = "true";
const { databaseFactory } = await import("@/database/database");
const { librariesRepository } = await import("@/database/repositories/libraries.repository");
const { mediaRepository } = await import("@/database/repositories/media-files.repository");
const { metadataRepository } = await import("@/database/repositories/metadata.repository");
const { playbackRepository } = await import("@/database/repositories/playback.repository");
const { watchedHistoryRepository } = await import("@/database/repositories/watched-history.repository");
const { playbackProgressService } = await import("@/modules/streaming/progress/playback-progress.service");

export const meta = { description: "Statement-count audit (queries per operation, targets gate --strict)" };

const PROFILE_ID = "profile-1";
const MOVIE_ID = "meta-0000001";
const LIBRARY_ID = "lib-bench";
const BATCH_SIZE = 50;
const BATCH_IDS = Array.from({ length: BATCH_SIZE }, (_, i) => `meta-${String(i).padStart(7, "0")}`);

interface OperationCase {
	name: string;
	/** Post-optimization statement budget; null = audit only, no gate. */
	target: number | null;
	run: () => Promise<unknown>;
}

const args = suiteArgs();

if (!args.help) {
	task("query-count: statement counts per operation", async () => {
		console.log(`[query-count] migrating and seeding ${args.rows} rows...`);
		databaseFactory.migrate();
		seedCatalog(databaseFactory.sqlite, {
			rows: args.rows,
			repositoryExtras: true,
			history: { profileId: PROFILE_ID, everyNth: 3, duration: 3000 },
			progress: true,
			analyze: true,
		});

		const cases: OperationCase[] = [
			{
				name: "metadataRepository.findPage (24, full)",
				target: null,
				run: () => metadataRepository.findPage({ limit: 24 }),
			},
			{
				name: "metadataRepository.findById (movie detail)",
				target: null,
				run: () => metadataRepository.findById({ primaryId: MOVIE_ID }),
			},
			{
				name: "librariesRepository.findByIdForRead (fields=id,type)",
				target: 1,
				run: () => librariesRepository.findByIdForRead(LIBRARY_ID, { fields: "id,type" }),
			},
			{
				name: "mediaRepository.findPage (24)",
				target: null,
				run: () => mediaRepository.findPage({ limit: 24 }),
			},
			{
				name: "watchedHistoryRepository.findPage (50)",
				target: null,
				run: () => watchedHistoryRepository.findPage(PROFILE_ID, { limit: 50 }),
			},
			{
				name: "playbackRepository.findSmartPlayData (single id)",
				target: null,
				run: () => playbackRepository.findSmartPlayData(MOVIE_ID, PROFILE_ID),
			},
			{
				name: `playbackProgressService.getSmartPlayBatch (${BATCH_SIZE} ids)`,
				target: 8,
				run: () => playbackProgressService.getSmartPlayBatch(BATCH_IDS, PROFILE_ID),
			},
			{
				name: "playbackRepository.findContinueWatchingData (12)",
				target: null,
				run: () => playbackRepository.findContinueWatchingData(PROFILE_ID, 12),
			},
		];

		const results: Array<{ name: string; statements: number; target: number | null; ms: number; ok: boolean }> = [];
		for (const operationCase of cases) {
			databaseFactory.resetQueryStats();
			const start = performance.now();
			await operationCase.run();
			const ms = performance.now() - start;
			const { queryCount } = databaseFactory.getQueryStats();
			const ok = operationCase.target === null || queryCount <= operationCase.target;
			results.push({ name: operationCase.name, statements: queryCount, target: operationCase.target, ms, ok });
		}

		const tableRows = results.map((result) => {
			const target = result.target === null ? "-" : String(result.target);
			let status = "audit";
			if (result.target !== null) status = result.ok ? "ok" : "over";

			return [result.name, String(result.statements), target, result.ms.toFixed(2), status];
		});
		printTable(
			"Statements per operation (target = post-optimization budget)",
			["operation", "statements", "target", "ms", "status"],
			tableRows,
		);

		const failing = results.filter((result) => !result.ok);
		if (failing.length > 0) {
			console.log(`\n[query-count] ${failing.length}/${results.length} operations over budget:`);
			for (const result of failing) console.log(`  - ${result.name}: ${String(result.statements)} > ${String(result.target)}`);
		} else {
			console.log(`\n[query-count] all ${results.length} operations within budget.`);
		}

		return {
			ok: failing.length === 0,
			data: { operations: results.length, overBudget: failing.length, rows: args.rows },
		};
	});
}

await main(import.meta);
