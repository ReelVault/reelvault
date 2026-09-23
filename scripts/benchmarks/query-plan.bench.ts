/**
 * Query-plan audit.
 *
 * Boots an isolated, migrated and seeded database and runs `EXPLAIN QUERY PLAN`
 * over the SQL shapes the hot repositories emit. The goal is not timing but
 * structure: flag `TEMP B-TREE` (an ORDER BY that no index can serve) and
 * full-table `SCAN`s, which are the failure modes that grow with catalog size.
 *
 * Usage:
 *   bun run scripts/benchmark.ts query-plan [--rows 5000] [--strict]
 *
 * `--strict` exits non-zero when any query is flagged, so CI can gate on it.
 * Plans are machine/SQLite-version specific — compare runs from the same box.
 */

import { main, printTable, suiteArgs, task } from "benchkit";
import { isRecord } from "@/utils/type.utils";
import { benchDb } from "./lib/db-fixture";
import { seedCatalog } from "./lib/seed";

export const meta = { description: "EXPLAIN QUERY PLAN audit (flags TEMP B-TREE sorts and full table scans)" };

/** Pending worker jobs seeded so the claim query has a realistic backlog to scan. */
const WORKER_ROWS = 10_000;

interface QueryCase {
	name: string;
	sql: string;
	params?: ReadonlyArray<string | number>;
}

interface PlanRow {
	detail: string;
}

interface PlanResult {
	name: string;
	detail: string;
	flags: string[];
}

/** A plan line is a full table scan when it says `SCAN <table>` with no index. */
function planFlags(rows: readonly PlanRow[]): string[] {
	const flags = new Set<string>();
	for (const row of rows) {
		const detail = row.detail.trim();
		if (detail.includes("TEMP B-TREE")) flags.add("temp-b-tree");
		// `SCAN (subquery-N)` is a co-routine/materialized subquery, not a base-table
		// scan; only `SCAN <table>` with no index is a real full scan.
		else if (detail.startsWith("SCAN ") && !detail.includes("USING") && !detail.includes("VIRTUAL") && !detail.includes("("))
			flags.add("full-scan");
	}

	return [...flags];
}

function buildCases(rows: number, now: number): QueryCase[] {
	const deepOffset = Math.max(0, Math.floor(rows / 2));
	const metadataColumns =
		"id, stable_key, title, original_title, overview, tagline, type, status, release_date, origin_country, budget, revenue, popularity, match_score, has_missing_translation, created_at, updated_at";
	const hasMedia = "EXISTS (SELECT 1 FROM media_files WHERE media_files.metadata_id = metadata.id)";

	return [
		{
			name: "metadata browse (ORDER BY title, id)",
			sql: `SELECT ${metadataColumns} FROM metadata WHERE ${hasMedia} ORDER BY title, id LIMIT 24 OFFSET 0`,
		},
		{
			name: "metadata deep offset page",
			sql: `SELECT ${metadataColumns} FROM metadata WHERE ${hasMedia} ORDER BY title, id LIMIT 24 OFFSET ${deepOffset}`,
		},
		{
			name: "metadata sort by popularity",
			sql: `SELECT ${metadataColumns} FROM metadata WHERE ${hasMedia} ORDER BY popularity, id LIMIT 24`,
		},
		{
			name: "metadata sort by releaseDate",
			sql: `SELECT ${metadataColumns} FROM metadata WHERE ${hasMedia} ORDER BY release_date, id LIMIT 24`,
		},
		{
			name: "metadata sort by updatedAt",
			sql: `SELECT ${metadataColumns} FROM metadata WHERE ${hasMedia} ORDER BY updated_at, id LIMIT 24`,
		},
		{
			name: "metadata sort by sortTitle (COLLATE NOCASE)",
			sql: `SELECT ${metadataColumns} FROM metadata WHERE ${hasMedia} ORDER BY COALESCE(sort_title, title) COLLATE NOCASE, id LIMIT 24`,
		},
		{
			name: "metadata filtered (year + genre)",
			sql: `SELECT ${metadataColumns} FROM metadata WHERE release_date >= '2020-01-01' AND release_date <= '2023-12-31' AND EXISTS (SELECT 1 FROM metadata_genres WHERE metadata_genres.metadata_id = metadata.id AND metadata_genres.genre_id IN ('genre-1')) AND ${hasMedia} ORDER BY title, id LIMIT 24`,
		},
		{
			name: "metadata count (browse filter)",
			sql: `SELECT count(*) FROM metadata WHERE ${hasMedia}`,
		},
		{
			name: "metadata detail by id",
			sql: "SELECT * FROM metadata WHERE id = ?",
			params: [`meta-${String(rows >> 1).padStart(7, "0")}`],
		},
		{
			name: "similar scoring (COUNT(*) OVER ())",
			sql: `SELECT m.id, (SELECT COUNT(*) * 30 FROM metadata_genres WHERE metadata_genres.metadata_id = m.id AND metadata_genres.genre_id IN ('genre-1')) + CASE WHEN m.type = 'movie' THEN 50 ELSE 0 END AS score, COUNT(*) OVER () AS total FROM metadata m WHERE m.id != ? AND m.type = 'movie' AND m.id IN (SELECT metadata_id FROM metadata_genres WHERE genre_id IN ('genre-1')) ORDER BY score DESC LIMIT 13 OFFSET 0`,
			params: ["meta-0000001"],
		},
		{
			name: "FTS5 metadata title search",
			sql: "SELECT m.id FROM metadata_fts f JOIN metadata m ON m.id = f.metadata_id WHERE metadata_fts MATCH 'star*' ORDER BY rank LIMIT 24",
		},
		{
			name: "watched-history page (joins + order)",
			sql: "SELECT watched_history.id FROM watched_history INNER JOIN media_files ON media_files.id = watched_history.media_file_id INNER JOIN metadata ON metadata.id = media_files.metadata_id LEFT JOIN episodes ON episodes.id = media_files.episode_id LEFT JOIN seasons ON seasons.id = episodes.season_id WHERE watched_history.profile_id = 'profile-1' ORDER BY watched_history.watched_at DESC LIMIT 50 OFFSET 0",
		},
		{
			name: "watched-history count",
			sql: "SELECT count(*) FROM watched_history WHERE profile_id = 'profile-1'",
		},
		{
			name: "continue-watching (order by updatedAt)",
			sql: "SELECT playback_progress.id FROM playback_progress INNER JOIN media_files ON media_files.id = playback_progress.media_file_id WHERE playback_progress.profile_id = 'profile-1' ORDER BY playback_progress.updated_at DESC LIMIT 50",
		},
		{
			name: "worker claim candidates",
			sql: "SELECT id, worker_id, operation_id, depends_on_job_id, attempts, max_attempts, priority, run_at FROM worker_jobs WHERE worker_id = 'media-file-analysis' AND status = 'pending' AND run_at <= ? ORDER BY priority ASC, run_at ASC, created_at ASC LIMIT 20",
			params: [now],
		},
		{
			name: "worker running count",
			sql: "SELECT count(*) FROM worker_jobs WHERE worker_id = 'media-file-analysis' AND status = 'running'",
		},
		{
			name: "worker dedupe lookup (active keys)",
			sql: "SELECT id, operation_id FROM worker_jobs WHERE worker_id = 'media-file-analysis' AND dedupe_key IN ('d-1','d-2','d-3','d-4','d-5') AND status IN ('pending','running')",
		},
		{
			name: "worker recover expired leases",
			sql: "SELECT id, operation_id, attempts, max_attempts FROM worker_jobs WHERE worker_id = 'media-file-analysis' AND status = 'running' AND lease_until < ?",
			params: [now],
		},
		{
			name: "worker trim (completed, keep 100)",
			sql: "DELETE FROM worker_jobs WHERE id IN (SELECT id FROM worker_jobs WHERE worker_id = 'media-file-analysis' AND status = 'completed' AND operation_id IS NULL ORDER BY completed_at DESC, created_at DESC LIMIT -1 OFFSET 100)",
		},
	];
}

const args = suiteArgs();

if (!args.help) {
	const database = benchDb({
		label: "plan",
		rows: args.rows,
		analyze: true,
		seed: (db) =>
			seedCatalog(db, {
				rows: args.rows,
				staggeredTimestamps: true,
				matchScore: true,
				history: { profileId: "profile-1", everyNth: 3, duration: 3000 },
				progress: true,
				workerJobs: WORKER_ROWS,
			}),
	});

	task("query-plan audit", async () => {
		const factory = (await database()).factory;
		const db = factory.sqlite;
		const cases = buildCases(args.rows, Date.now());
		const results: PlanResult[] = [];

		for (const queryCase of cases) {
			const planRows: PlanRow[] = db
				.query(`EXPLAIN QUERY PLAN ${queryCase.sql}`)
				.all(...(queryCase.params ?? []))
				.map((row) => ({ detail: isRecord(row) && typeof row.detail === "string" ? row.detail : "" }));
			results.push({
				name: queryCase.name,
				detail: planRows.map((row) => row.detail.trim()).join(" | "),
				flags: planFlags(planRows),
			});
		}

		printTable(
			"Query plans (flags: temp-b-tree = ORDER BY sort, full-scan = unindexed table scan)",
			["query", "flags", "plan"],
			results.map((result) => [result.name, result.flags.length > 0 ? result.flags.join(",") : "ok", result.detail]),
		);

		const flagged = results.filter((result) => result.flags.length > 0);
		if (flagged.length > 0) {
			console.log(`\n[query-plan] ${flagged.length}/${results.length} queries flagged:`);
			for (const result of flagged) console.log(`  - ${result.name}: ${result.flags.join(", ")}`);
		} else {
			console.log(`\n[query-plan] all ${results.length} queries use index-supported plans.`);
		}

		return { ok: flagged.length === 0, data: { flagged: flagged.length, total: results.length } };
	});
}

await main(import.meta);
