import { bench, fixture, group, main, measure, printMicroResults, suiteArgs, task } from "benchkit";
import { isRecord } from "@/utils/type.utils";
import { benchDb } from "./lib/db-fixture";
import { seedCatalog } from "./lib/seed";

export const meta = { description: "Database & FTS5 query engine (real migrations, FTS5 search, pagination, joins)" };

const args = suiteArgs();

if (!args.help) {
	const factoryFixture = benchDb({
		label: "db",
		rows: args.rows,
		analyze: false,
		seed: (db) => seedCatalog(db, { rows: args.rows, staggeredTimestamps: true }),
	});

	const database = fixture("bench-db-prepared", async () => {
		const { factory, seedNow } = await factoryFixture();
		const db = factory.sqlite;
		const rows = args.rows;
		const now = seedNow;
		console.log(`[database] seeding complete. Running queries (${args.iterations} iterations)...`);

		const prepared = {
			ftsMetadataQuery: db.prepare(`
				SELECT m.id, m.title, m.popularity
				FROM metadata_fts f
				JOIN metadata m ON m.id = f.metadata_id
				WHERE metadata_fts MATCH ?
				ORDER BY rank
				LIMIT 24
			`),
			ftsPeopleQuery: db.prepare(`
				SELECT p.id, p.name
				FROM people_fts f
				JOIN people p ON p.id = f.person_id
				WHERE people_fts MATCH ?
				ORDER BY rank
				LIMIT 10
			`),
			offsetPaginationQuery: db.prepare(`
				SELECT id, title, popularity, release_date
				FROM metadata
				WHERE type = 'movie'
				ORDER BY created_at DESC
				LIMIT 24 OFFSET 500
			`),
			cursorPaginationQuery: db.prepare(`
				SELECT id, title, popularity, release_date
				FROM metadata
				WHERE type = 'movie' AND created_at < ?
				ORDER BY created_at DESC
				LIMIT 24
			`),
			// Mirrors the API's default browse sort (findPage appends the primary key as
			// a tiebreaker) so the composite `(title, id)` index shows up in timings.
			titlePaginationQuery: db.prepare(`
				SELECT id, title, popularity, release_date
				FROM metadata
				WHERE type = 'movie'
				ORDER BY title, id
				LIMIT 24 OFFSET 500
			`),
			filteredPaginationQuery: db.prepare(`
				SELECT id, title, popularity, release_date
				FROM metadata
				WHERE release_date >= '2024-01-01' AND release_date <= '2024-12-31'
					AND EXISTS (SELECT 1 FROM metadata_genres WHERE metadata_genres.metadata_id = metadata.id AND metadata_genres.genre_id IN ('genre-1'))
				ORDER BY title, id
				LIMIT 24
			`),
			byIdQuery: db.prepare(`
				SELECT id, title, overview, release_date, popularity
				FROM metadata
				WHERE id = ?
			`),
			relationJoinQuery: db.prepare(`
				SELECT m.id, m.title, mf.file_path, g.name AS genre_name
				FROM metadata m
				JOIN movies mov ON mov.metadata_id = m.id
				JOIN media_files mf ON mf.movie_id = mov.id
				LEFT JOIN metadata_genres mg ON mg.metadata_id = m.id
				LEFT JOIN genres g ON g.id = mg.genre_id
				WHERE m.id = ?
			`),
			insertWriteStmt: db.prepare(`
				INSERT INTO metadata (id, stable_key, title, original_title, type, release_date, popularity, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'movie', '2024-01-01', 50, ?, ?)
			`),
		};

		return { factory, db, rows, now, writeCounter: 0, ...prepared };
	});

	// ─── A/B: ANALYZE (planner statistics) on tiebreaker sorts ─────────────
	// A freshly seeded database has no sqlite_stat1, so the planner guesses and
	// picks a type index + TEMP B-TREE sort instead of the composite
	// `(sortKey, id)` index. The main timings below run AFTER ANALYZE so they
	// reflect production; this pair documents the difference.
	task("database: ANALYZE planner statistics", async () => {
		const { db, titlePaginationQuery, filteredPaginationQuery } = await database();
		const planOf = (sql: string): string =>
			db
				.query(`EXPLAIN QUERY PLAN ${sql}`)
				.all()
				.map((row) => (isRecord(row) && typeof row.detail === "string" ? row.detail.trim() : ""))
				.join(" | ");
		const titlePlanSql =
			"SELECT id, title, popularity, release_date FROM metadata WHERE type = 'movie' ORDER BY title, id LIMIT 24 OFFSET 500";
		const filteredPlanSql =
			"SELECT id, title, popularity, release_date FROM metadata WHERE release_date >= '2024-01-01' AND release_date <= '2024-12-31' AND EXISTS (SELECT 1 FROM metadata_genres WHERE metadata_genres.metadata_id = metadata.id AND metadata_genres.genre_id IN ('genre-1')) ORDER BY title, id LIMIT 24";
		const titlePlanBefore = planOf(titlePlanSql);
		const analyzeResults = [
			measure("browse ORDER BY title,id BEFORE ANALYZE", () => titlePaginationQuery.all(), { iterations: 300 }),
			measure("filtered year+genre BEFORE ANALYZE", () => filteredPaginationQuery.all(), { iterations: 300 }),
		];
		db.run("ANALYZE");
		analyzeResults.push(
			measure("browse ORDER BY title,id AFTER ANALYZE", () => titlePaginationQuery.all(), { iterations: 300 }),
			measure("filtered year+genre AFTER ANALYZE", () => filteredPaginationQuery.all(), { iterations: 300 }),
		);
		printMicroResults(analyzeResults);
		console.log(`  browse plan BEFORE ANALYZE: ${titlePlanBefore}`);
		console.log(`  browse plan AFTER ANALYZE:  ${planOf(titlePlanSql)}`);
		console.log(`  filtered plan AFTER ANALYZE: ${planOf(filteredPlanSql)}`);
	});

	group("Results (lower is better)", () => {
		bench("FTS5 metadata title search (bm25 rank)", async () => (await database()).ftsMetadataQuery.all("star*"), {
			iterations: args.iterations,
		});
		bench("FTS5 people search (bm25 rank)", async () => (await database()).ftsPeopleQuery.all("actor*"), {
			iterations: args.iterations,
		});
		bench("Catalog browse: offset pagination (LIMIT 24 OFFSET 500)", async () => (await database()).offsetPaginationQuery.all(), {
			iterations: args.iterations,
		});
		bench(
			"Catalog browse: keyset cursor (WHERE created_at < ? LIMIT 24)",
			async () => {
				const state = await database();

				return state.cursorPaginationQuery.all(state.now + Math.floor(state.rows / 2));
			},
			{ iterations: args.iterations },
		);
		bench("Catalog browse: ORDER BY title, id (OFFSET 500, tiebreaker index)", async () => (await database()).titlePaginationQuery.all(), {
			iterations: args.iterations,
		});
		bench("Catalog filtered: year + genre, ORDER BY title, id", async () => (await database()).filteredPaginationQuery.all(), {
			iterations: args.iterations,
		});
		bench(
			"Single row lookup by ID (indexed PK)",
			async () => {
				const state = await database();

				return state.byIdQuery.get(`meta-${String(state.rows >> 1).padStart(7, "0")}`);
			},
			{ iterations: args.iterations },
		);
		bench(
			"Media relations multi-table join (movie + file + genre)",
			async () => {
				const state = await database();

				return state.relationJoinQuery.all(`meta-${String(state.rows >> 1).padStart(7, "0")}`);
			},
			{ iterations: args.iterations },
		);
		bench(
			"Single row write with FTS5 trigger (WAL transaction)",
			async () => {
				const state = await database();
				state.writeCounter++;
				const id = `bench-write-${state.writeCounter}`;
				const t = Date.now();
				state.db.run("BEGIN");
				state.insertWriteStmt.run(id, id, `Benchmark Written ${state.writeCounter}`, `BW ${state.writeCounter}`, t, t);
				state.db.run("COMMIT");
			},
			{ iterations: args.iterations },
		);
	});

	// ─── A/B: large id-list lookups (informs table-access chunking) ─────
	// table-access chunks `IN (...)` lists by queryChunkSize (500). An
	// alternative is a temp-table JOIN. Honest comparison: the temp table
	// must be populated per call, because real id lists change per request.
	task("database: chunked IN vs temp-table JOIN", async () => {
		const { db, rows } = await database();
		for (const requestedSize of [1000, 10_000]) {
			const size = Math.min(requestedSize, rows);
			const uniqueIds = Array.from({ length: size }, (_, i) => `meta-${String(Math.floor((i * rows) / size)).padStart(7, "0")}`);
			const chunkedQuery = db.prepare(
				`SELECT id, title FROM metadata WHERE id IN (${uniqueIds
					.slice(0, 500)
					.map(() => "?")
					.join(",")})`,
			);
			db.run("CREATE TEMP TABLE IF NOT EXISTS bench_ids (id TEXT PRIMARY KEY)");
			const clearIds = db.prepare("DELETE FROM bench_ids");
			const insertId = db.prepare("INSERT INTO bench_ids VALUES (?)");
			const joinQuery = db.prepare("SELECT m.id, m.title FROM bench_ids b JOIN metadata m ON m.id = b.id");
			const rounds = 5;

			let chunkedCount = 0;
			const chunkedStart = performance.now();
			for (let round = 0; round < rounds; round++) {
				for (let offset = 0; offset < uniqueIds.length; offset += 500) {
					chunkedCount += chunkedQuery.all(...uniqueIds.slice(offset, offset + 500)).length;
				}
			}

			const chunkedMs = (performance.now() - chunkedStart) / rounds;

			let joinCount = 0;
			const joinStart = performance.now();
			for (let round = 0; round < rounds; round++) {
				clearIds.run();
				db.run("BEGIN");
				for (const id of uniqueIds) insertId.run(id);

				db.run("COMMIT");
				joinCount += joinQuery.all().length;
			}

			const joinMs = (performance.now() - joinStart) / rounds;

			// Both paths must return the same row count — a mismatch invalidates the run.
			if (chunkedCount !== joinCount) throw new Error(`A/B row mismatch: IN=${chunkedCount}, JOIN=${joinCount}`);

			console.log(`  ids=${uniqueIds.length}: chunked IN = ${chunkedMs.toFixed(2)}ms/call, temp-table JOIN = ${joinMs.toFixed(2)}ms/call`);
		}
	});

	// ─── A/B: PRAGMA mmap_size (informs whether to add it in database.ts) ──
	task("database: PRAGMA mmap_size", async () => {
		const { db } = await database();
		console.log("\n[database] A/B: PRAGMA mmap_size on browse/detail queries...");
		const browseProbe = db.prepare("SELECT id, title, popularity FROM metadata WHERE type = 'movie' ORDER BY created_at DESC LIMIT 24");
		const mmapResults = [measure("browse WITHOUT mmap", () => browseProbe.all(), { iterations: 300 })];
		db.run("PRAGMA mmap_size=268435456");
		mmapResults.push(measure("browse WITH mmap_size=256MB", () => browseProbe.all(), { iterations: 300 }));
		printMicroResults(mmapResults);
	});
}

await main(import.meta);
