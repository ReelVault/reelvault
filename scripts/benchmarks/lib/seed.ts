import type { Database } from "bun:sqlite";

export interface CatalogSeedOptions {
	/** Catalog rows (metadata + movie + media file per row). */
	rows: number;
	/** created_at/updated_at = base + i instead of a constant — drives offset/keyset pagination order. */
	staggeredTimestamps?: boolean;
	/** Populate metadata.match_score (query-plan metadata shape). */
	matchScore?: boolean;
	/** Per-row release years 2021–2025 instead of constant 2024 (year-filter query). */
	variedReleaseYears?: boolean;
	/** keywords + collections + metadata_crew rows (repository read paths). */
	repositoryExtras?: boolean;
	/** Watched-history rows: every Nth catalog row for one profile. */
	history?: {
		profileId: string;
		everyNth: number;
		duration: number;
	};
	/** playback_progress rows every 5th catalog row (profile-1, mid-position). */
	progress?: boolean;
	/** worker_jobs backlog (25% running, rest pending) for the claim queries. */
	workerJobs?: number;
	/** people rows (default 100); cast rotates over them. */
	people?: number;
	/** Run ANALYZE after seeding so the planner sees statistics. */
	analyze?: boolean;
}

/**
 * The shared catalog seeder for in-process DB suites. One place for the seed
 * shape — flags map to real per-suite differences, never to cosmetics. The
 * managed-server seeder (lib/server.ts) is a different domain (posters,
 * images, seasons/episodes) and deliberately stays separate.
 *
 * Returns the base timestamp the rows were seeded with.
 */
export function seedCatalog(db: Database, options: CatalogSeedOptions): number {
	const now = Math.floor(Date.now() / 1000);
	const staggered = options.staggeredTimestamps ?? false;
	const people = options.people ?? 100;

	db.run("PRAGMA foreign_keys = OFF");
	db.run("BEGIN");

	db.prepare(
		"INSERT INTO libraries (id, name, type, metadata_storage_mode, created_at, updated_at) VALUES ('lib-bench', 'Bench', 'movies', 'database', ?, ?)",
	).run(now, now);

	const matchScoreColumn = options.matchScore ? ", match_score" : "";
	const matchScorePlaceholder = options.matchScore ? ", ?" : "";
	const insertMetadata = db.prepare(
		`INSERT INTO metadata (id, stable_key, title, original_title, overview, tagline, type, status, release_date, origin_country, popularity${matchScoreColumn}, created_at, updated_at) VALUES (?, ?, ?, ?, 'Overview', 'Tagline', 'movie', 'released', ?, 'US', ?${matchScorePlaceholder}, ?, ?)`,
	);
	const insertMovie = db.prepare("INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
	const insertMediaFile = db.prepare(
		"INSERT INTO media_files (id, library_id, metadata_id, movie_id, file_path, file_name, duration, file_size, is_default, created_at, updated_at) VALUES (?, 'lib-bench', ?, ?, ?, ?, 6000, 4000000000, 1, ?, ?)",
	);
	const insertGenre = db.prepare("INSERT INTO genres (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
	const insertMetadataGenre = db.prepare("INSERT INTO metadata_genres (metadata_id, genre_id) VALUES (?, ?)");
	const insertPerson = db.prepare("INSERT INTO people (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
	const insertCast = db.prepare("INSERT INTO metadata_cast (metadata_id, person_id, role, sort_order) VALUES (?, ?, 'Actor', 0)");
	const insertKeyword = db.prepare("INSERT INTO keywords (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
	const insertMetadataKeyword = db.prepare("INSERT INTO metadata_keywords (metadata_id, keyword_id) VALUES (?, ?)");
	const insertCollection = db.prepare(
		"INSERT INTO collections (id, stable_key, name, sort_mode, created_at, updated_at) VALUES (?, ?, ?, 'alphabetical', ?, ?)",
	);
	const insertMetadataCollection = db.prepare("INSERT INTO metadata_collections (metadata_id, collection_id, sort_order) VALUES (?, ?, ?)");
	const insertCrew = db.prepare(
		"INSERT INTO metadata_crew (metadata_id, person_id, job, department) VALUES (?, ?, 'Director', 'Directing')",
	);
	const insertHistory = db.prepare(
		"INSERT INTO watched_history (id, media_file_id, profile_id, duration_watched, is_full_watch, watched_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
	);
	const insertProgress = db.prepare(
		"INSERT INTO playback_progress (id, profile_id, media_file_id, position, duration, completed, created_at, updated_at) VALUES (?, 'profile-1', ?, 1000, 6000, 0, ?, ?)",
	);
	const insertJob = db.prepare(
		"INSERT INTO worker_jobs (id, worker_id, data, status, priority, attempts, max_attempts, run_at, created_at, updated_at) VALUES (?, 'media-file-analysis', '{}', ?, 0, 0, 3, ?, ?, ?)",
	);

	for (let g = 0; g < 10; g++) insertGenre.run(`genre-${g}`, `genre-${g}`, `Genre ${g}`, now, now);

	for (let p = 0; p < people; p++) insertPerson.run(`person-${p}`, `person-${p}`, `Actor ${p} Star`, now, now);

	if (options.repositoryExtras) {
		for (let k = 0; k < 10; k++) insertKeyword.run(`kw-${k}`, `kw-${k}`, `Keyword ${k}`, now, now);

		for (let c = 0; c < 5; c++) insertCollection.run(`col-${c}`, `col-${c}`, `Collection ${c}`, now, now);
	}

	const history = options.history;
	for (let i = 0; i < options.rows; i++) {
		const id = `meta-${String(i).padStart(7, "0")}`;
		const title = i % 4 === 0 ? `Star Odyssey ${i}` : `Benchmark Title ${i}`;
		const createdAt = staggered ? now + i : now;
		const releaseDate = options.variedReleaseYears ? `202${i % 5}-01-01` : "2024-01-01";
		insertMetadata.run(
			id,
			id,
			title,
			title,
			releaseDate,
			(i % 1000) / 10,
			...(options.matchScore ? [(i % 100) / 100] : []),
			createdAt,
			createdAt,
		);
		insertMovie.run(`movie-${id}`, id, id, createdAt, createdAt);
		insertMediaFile.run(`mf-${id}`, id, `movie-${id}`, `/media/m-${i}.mkv`, `m-${i}.mkv`, createdAt, createdAt);
		insertMetadataGenre.run(id, `genre-${i % 10}`);
		insertCast.run(id, `person-${i % people}`);

		if (options.repositoryExtras) {
			insertMetadataKeyword.run(id, `kw-${i % 10}`);
			insertMetadataCollection.run(id, `col-${i % 5}`, i);
			insertCrew.run(id, `person-${i % people}`);
		}

		if (history && i % history.everyNth === 0) {
			insertHistory.run(`wh-${i}`, `mf-${id}`, history.profileId, history.duration, now - i, createdAt, createdAt);
		}

		if (options.progress && i % 5 === 0) insertProgress.run(`pp-${i}`, `mf-${id}`, createdAt, now - i);
	}

	if (options.workerJobs !== undefined) {
		for (let i = 0; i < options.workerJobs; i++) {
			const status = i % 50 === 0 ? "running" : "pending";
			insertJob.run(`job-${i}`, status, now, now + i, now + i);
		}
	}

	db.run("COMMIT");
	db.run("PRAGMA foreign_keys = ON");
	if (options.analyze) db.run("ANALYZE");

	return now;
}
