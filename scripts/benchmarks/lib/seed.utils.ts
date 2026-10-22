import type { Database } from "bun:sqlite";
import { isRecord } from "@/utils/type.utils";

/**
 * Suites run against a fresh migrated database in the run's temp ROOT_DIR.
 * Seeding a database that already holds catalog rows silently mixes runs (or
 * aborts halfway on a UNIQUE violation and leaves the rest unseeded), so refuse
 * loudly — the fix is to go through `bun run benchmark`, which gives every run
 * its own root directory.
 */
function assertFreshDatabase(db: Database): void {
	const row = db.query("SELECT count(*) AS n FROM metadata").get();
	if (isRecord(row) && typeof row.n === "number" && row.n > 0) {
		throw new Error(`[bench] seedCatalog expects a fresh database, but metadata already holds ${row.n} rows`);
	}
}

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
	/** Creates the user+profile rows referenced by history/progress so runtime writes pass FK checks. */
	profile?: {
		id: string;
		userId?: string | undefined;
	};
	/** worker_jobs backlog (25% running, rest pending) for the claim queries. */
	workerJobs?: number;
	/** TV rows: series with seasons × episodesPerSeason episodes, each with a media file. */
	series?: {
		shows: number;
		seasons: number;
		episodesPerSeason: number;
	};
	/** people rows (default 100); cast rotates over them. */
	people?: number;
	/** Run ANALYZE after seeding so the planner sees statistics. */
	analyze?: boolean;
}

/**
 * The shared catalog seeder for in-process DB suites. One place for the seed
 * shape — flags map to real per-suite differences, never to cosmetics. The
 * managed server seeds its own richer catalog (`seedServerCatalog` below:
 * posters, interleaved series) that the HTTP suites' fixed ids depend on.
 *
 * Returns the base timestamp the rows were seeded with.
 */
export function seedCatalog(db: Database, options: CatalogSeedOptions): number {
	assertFreshDatabase(db);
	const now = Math.floor(Date.now() / 1000);

	db.run("PRAGMA foreign_keys = OFF");
	db.run("BEGIN");

	db.prepare(
		"INSERT INTO libraries (id, name, type, metadata_storage_mode, created_at, updated_at) VALUES ('lib-bench', 'Bench', 'movies', 'database', ?, ?)",
	).run(now, now);

	const statements = prepareCatalogStatements(db, options);
	seedLookupRows(statements, options, now);
	if (options.profile) seedProfile(db, options.profile, now);
	for (let i = 0; i < options.rows; i++) seedMovieRow(statements, options, i, now);

	if (options.workerJobs !== undefined) seedWorkerJobs(db, options.workerJobs, now);

	if (options.series) seedSeries(db, { series: options.series, matchScore: options.matchScore ?? false, now });

	db.run("COMMIT");
	db.run("PRAGMA foreign_keys = ON");
	if (options.analyze) db.run("ANALYZE");

	return now;
}

function prepareCatalogStatements(db: Database, options: CatalogSeedOptions) {
	const matchScoreColumn = options.matchScore ? ", match_score" : "";
	const matchScorePlaceholder = options.matchScore ? ", ?" : "";

	return {
		insertMetadata: db.prepare(
			`INSERT INTO metadata (id, stable_key, title, original_title, overview, tagline, type, status, release_date, origin_country, popularity${matchScoreColumn}, created_at, updated_at) VALUES (?, ?, ?, ?, 'Overview', 'Tagline', 'movie', 'released', ?, 'US', ?${matchScorePlaceholder}, ?, ?)`,
		),
		insertMovie: db.prepare("INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
		insertMediaFile: db.prepare(
			"INSERT INTO media_files (id, library_id, metadata_id, movie_id, file_path, file_name, duration, file_size, is_default, created_at, updated_at) VALUES (?, 'lib-bench', ?, ?, ?, ?, 6000, 4000000000, 1, ?, ?)",
		),
		insertGenre: db.prepare("INSERT INTO genres (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
		insertMetadataGenre: db.prepare("INSERT INTO metadata_genres (metadata_id, genre_id) VALUES (?, ?)"),
		insertPerson: db.prepare("INSERT INTO people (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
		insertCast: db.prepare("INSERT INTO metadata_cast (metadata_id, person_id, role, sort_order) VALUES (?, ?, 'Actor', 0)"),
		insertKeyword: db.prepare("INSERT INTO keywords (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
		insertMetadataKeyword: db.prepare("INSERT INTO metadata_keywords (metadata_id, keyword_id) VALUES (?, ?)"),
		insertCollection: db.prepare(
			"INSERT INTO collections (id, stable_key, name, sort_mode, created_at, updated_at) VALUES (?, ?, ?, 'alphabetical', ?, ?)",
		),
		insertMetadataCollection: db.prepare("INSERT INTO metadata_collections (metadata_id, collection_id, sort_order) VALUES (?, ?, ?)"),
		insertCrew: db.prepare("INSERT INTO metadata_crew (metadata_id, person_id, job, department) VALUES (?, ?, 'Director', 'Directing')"),
		insertHistory: db.prepare(
			"INSERT INTO watched_history (id, media_file_id, profile_id, duration_watched, is_full_watch, watched_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
		),
		insertProgress: db.prepare(
			"INSERT INTO playback_progress (id, profile_id, media_file_id, position, duration, completed, created_at, updated_at) VALUES (?, 'profile-1', ?, 1000, 6000, 0, ?, ?)",
		),
	};
}

type CatalogStatements = ReturnType<typeof prepareCatalogStatements>;

function seedLookupRows(statements: CatalogStatements, options: CatalogSeedOptions, now: number): void {
	const people = options.people ?? 100;

	for (let g = 0; g < 10; g++) statements.insertGenre.run(`genre-${g}`, `genre-${g}`, `Genre ${g}`, now, now);

	for (let p = 0; p < people; p++) statements.insertPerson.run(`person-${p}`, `person-${p}`, `Actor ${p} Star`, now, now);

	if (options.repositoryExtras) {
		for (let k = 0; k < 10; k++) statements.insertKeyword.run(`kw-${k}`, `kw-${k}`, `Keyword ${k}`, now, now);

		for (let c = 0; c < 5; c++) statements.insertCollection.run(`col-${c}`, `col-${c}`, `Collection ${c}`, now, now);
	}
}

function seedProfile(db: Database, profile: NonNullable<CatalogSeedOptions["profile"]>, now: number): void {
	const userId = profile.userId ?? `user-${profile.id}`;
	db.prepare("INSERT INTO users (id, name, email, emailVerified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run(
		userId,
		userId,
		`${userId}@bench.local`,
		now,
		now,
	);
	db.prepare("INSERT INTO profiles (id, userId, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
		profile.id,
		userId,
		profile.id,
		now,
		now,
	);
}

function seedMovieRow(statements: CatalogStatements, options: CatalogSeedOptions, i: number, now: number): void {
	const people = options.people ?? 100;
	const staggered = options.staggeredTimestamps ?? false;
	const history = options.history;
	const id = `meta-${String(i).padStart(7, "0")}`;
	const title = i % 4 === 0 ? `Star Odyssey ${i}` : `Benchmark Title ${i}`;
	const createdAt = staggered ? now + i : now;
	const releaseDate = options.variedReleaseYears ? `202${i % 5}-01-01` : "2024-01-01";
	statements.insertMetadata.run(
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
	statements.insertMovie.run(`movie-${id}`, id, id, createdAt, createdAt);
	statements.insertMediaFile.run(`mf-${id}`, id, `movie-${id}`, `/media/m-${i}.mkv`, `m-${i}.mkv`, createdAt, createdAt);
	statements.insertMetadataGenre.run(id, `genre-${i % 10}`);
	statements.insertCast.run(id, `person-${i % people}`);

	if (options.repositoryExtras) {
		statements.insertMetadataKeyword.run(id, `kw-${i % 10}`);
		statements.insertMetadataCollection.run(id, `col-${i % 5}`, i);
		statements.insertCrew.run(id, `person-${i % people}`);
	}

	if (history && i % history.everyNth === 0) {
		statements.insertHistory.run(`wh-${i}`, `mf-${id}`, history.profileId, history.duration, now - i, createdAt, createdAt);
	}

	if (options.progress && i % 5 === 0) statements.insertProgress.run(`pp-${i}`, `mf-${id}`, createdAt, now - i);
}

/** worker_jobs backlog for the claim/purge suites (every 50th row is running). */
function seedWorkerJobs(db: Database, count: number, now: number): void {
	const insertJob = db.prepare(
		"INSERT INTO worker_jobs (id, worker_id, data, status, priority, attempts, max_attempts, run_at, created_at, updated_at) VALUES (?, 'media-file-analysis', '{}', ?, 0, 0, 3, ?, ?, ?)",
	);

	for (let i = 0; i < count; i++) {
		const status = i % 50 === 0 ? "running" : "pending";
		insertJob.run(`job-${i}`, status, now, now + i, now + i);
	}
}

/** TV rows for suites that need seasons/episodes (playback view, sidecar saves). */
function seedSeries(db: Database, options: { series: NonNullable<CatalogSeedOptions["series"]>; matchScore: boolean; now: number }): void {
	const { series, now } = options;
	const matchScoreColumn = options.matchScore ? ", match_score" : "";
	const matchScorePlaceholder = options.matchScore ? ", ?" : "";
	const insertShow = db.prepare(
		`INSERT INTO metadata (id, stable_key, title, original_title, overview, tagline, type, status, release_date, origin_country, popularity${matchScoreColumn}, created_at, updated_at) VALUES (?, ?, ?, ?, 'Overview', 'Tagline', 'tv_show', 'released', '2024-01-01', 'US', 50${matchScorePlaceholder}, ?, ?)`,
	);
	const insertSeason = db.prepare(
		"INSERT INTO seasons (id, stable_key, metadata_id, season_number, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const insertEpisode = db.prepare(
		"INSERT INTO episodes (id, stable_key, season_id, type, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, 'regular', ?, ?, ?, ?)",
	);
	const insertEpisodeFile = db.prepare(
		"INSERT INTO media_files (id, library_id, metadata_id, episode_id, file_path, file_name, duration, file_size, is_default, created_at, updated_at) VALUES (?, 'lib-bench', ?, ?, ?, ?, 6000, 4000000000, 1, ?, ?)",
	);

	for (let showIndex = 0; showIndex < series.shows; showIndex++) {
		const showId = `show-${showIndex}`;
		insertShow.run(
			showId,
			showId,
			`Series ${showIndex}`,
			`Series ${showIndex}`,
			...(options.matchScore ? [(showIndex % 100) / 100] : []),
			now,
			now,
		);

		for (let seasonIndex = 0; seasonIndex < series.seasons; seasonIndex++) {
			const seasonId = `season-${showIndex}-${seasonIndex}`;
			insertSeason.run(seasonId, seasonId, showId, seasonIndex + 1, `Season ${seasonIndex + 1}`, now, now);

			for (let episodeIndex = 0; episodeIndex < series.episodesPerSeason; episodeIndex++) {
				const episodeId = `episode-${showIndex}-${seasonIndex}-${episodeIndex}`;
				insertEpisode.run(episodeId, episodeId, seasonId, episodeIndex + 1, `Episode ${episodeIndex + 1}`, now, now);
				insertEpisodeFile.run(`mf-${episodeId}`, showId, episodeId, `/media/${episodeId}.mkv`, `${episodeId}.mkv`, now, now);
			}
		}
	}
}

/** The poster image every 3rd server-catalog title links to. */
export const BENCHMARK_IMAGE_ID = "img-benchmark";
/** Every Nth seeded title becomes a tv_show with seasons/episodes. */
const TV_SHOW_CYCLE = 8;
const EPISODES_BASE = 6;
/** Watchlist / ratings entries per benchmark profile. */
const WATCHLIST_PER_PROFILE = 40;
const RATINGS_PER_PROFILE = 25;
/** In-progress movies per benchmark profile (playback_progress rows). */
const IN_PROGRESS_MOVIES_PER_PROFILE = 30;
/** TV shows per profile with a completed last episode + in-progress one before it. */
const TV_PROGRESS_SHOWS_PER_PROFILE = 10;
/** Watched-history rows per benchmark profile (~90 days of activity). */
const HISTORY_PER_PROFILE = 300;
/** Notifications per profile; the first UNREAD_NOTIFICATIONS stay unread. */
const NOTIFICATIONS_PER_PROFILE = 50;
const UNREAD_NOTIFICATIONS = 15;

/**
 * The managed server's catalog: a realistic shape so listing, search and detail endpoints return
 * non-trivial payloads — every 8th title a series with seasons and episodes, a poster on every 3rd.
 * `posterPath` is a real PNG on disk, so the image route serves real bytes.
 */
export function seedServerCatalog(database: Database, rows: number, posterPath: string): void {
	database.run("PRAGMA foreign_keys = OFF");
	database.run("BEGIN");

	const now = Math.floor(Date.now() / 1000);
	database
		.prepare(
			"INSERT INTO libraries (id, name, type, metadata_storage_mode, created_at, updated_at) VALUES (?, ?, 'movies', 'database', ?, ?)",
		)
		.run("lib-benchmark", "Benchmark Movies", now, now);

	const inserts = prepareCatalogInserts(database);

	inserts.insertImage.run(BENCHMARK_IMAGE_ID, posterPath, 731, now, now);

	seedCatalogLookups(inserts, now);
	for (let index = 0; index < rows; index++) {
		seedCatalogTitle(inserts, index, now);
	}

	database.run("COMMIT");
	database.run("PRAGMA foreign_keys = ON");
}

function prepareCatalogInserts(database: Database) {
	return {
		insertMetadata: database.prepare(
			"INSERT INTO metadata (id, stable_key, title, original_title, overview, tagline, type, status, release_date, origin_country, popularity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'released', ?, 'US', ?, ?, ?)",
		),
		insertMovie: database.prepare("INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
		insertMediaFile: database.prepare(
			"INSERT INTO media_files (id, library_id, metadata_id, movie_id, episode_id, file_path, file_name, duration, file_size, is_default, created_at, updated_at) VALUES (?, 'lib-benchmark', ?, ?, ?, ?, ?, ?, 4000000000, 1, ?, ?)",
		),
		insertSeason: database.prepare(
			"INSERT INTO seasons (id, stable_key, metadata_id, season_number, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		),
		insertEpisode: database.prepare(
			"INSERT INTO episodes (id, stable_key, season_id, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		),
		insertGenre: database.prepare("INSERT INTO genres (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
		insertMetadataGenre: database.prepare("INSERT INTO metadata_genres (metadata_id, genre_id) VALUES (?, ?)"),
		insertImage: database.prepare(
			"INSERT INTO images (id, stable_key, local_path, content_type, width, height, file_size, created_at, updated_at) VALUES (?, 'benchmark-poster', ?, 'image/png', 128, 192, ?, ?, ?)",
		),
		insertMetadataImage: database.prepare("INSERT INTO metadata_images (metadata_id, image_id, image_type) VALUES (?, ?, 'poster')"),
		insertPerson: database.prepare("INSERT INTO people (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
		insertCast: database.prepare("INSERT INTO metadata_cast (metadata_id, person_id, role, sort_order) VALUES (?, ?, 'Actor', ?)"),
		insertCollection: database.prepare(
			"INSERT INTO collections (id, stable_key, name, sort_mode, created_at, updated_at) VALUES (?, ?, ?, 'alphabetical', ?, ?)",
		),
		insertMetadataCollection: database.prepare(
			"INSERT INTO metadata_collections (metadata_id, collection_id, sort_order) VALUES (?, ?, ?)",
		),
	};
}

type CatalogInserts = ReturnType<typeof prepareCatalogInserts>;

function seedCatalogLookups(inserts: CatalogInserts, now: number): void {
	for (let genreIndex = 0; genreIndex < 10; genreIndex++) {
		inserts.insertGenre.run(`genre-${genreIndex}`, `genre-${genreIndex}`, `Genre ${genreIndex}`, now, now);
	}

	for (let personIndex = 0; personIndex < 50; personIndex++) {
		inserts.insertPerson.run(`person-${personIndex}`, `person-${personIndex}`, `Actor ${personIndex}`, now, now);
	}

	// Collections so the collections list endpoint exercises its grouped
	// qualification + preview queries instead of scanning empty tables.
	for (let collectionIndex = 0; collectionIndex < 5; collectionIndex++) {
		inserts.insertCollection.run(`col-${collectionIndex}`, `col-${collectionIndex}`, `Collection ${collectionIndex}`, now, now);
	}
}

/** Writes one title: its metadata row, the movie or TV branch, a genre, a cast member and an optional poster link. */
function seedCatalogTitle(inserts: CatalogInserts, index: number, now: number): void {
	const id = `meta-${String(index).padStart(7, "0")}`;
	const isTv = index % TV_SHOW_CYCLE === 0;
	const title = index % 5 === 0 ? `Star Odyssey ${index}` : `Benchmark Title ${index}`;
	inserts.insertMetadata.run(
		id,
		id,
		title,
		title,
		"Benchmark overview text for load testing.",
		"Benchmark tagline",
		isTv ? "tv_show" : "movie",
		`202${index % 5}-0${(index % 9) + 1}-15`,
		(index % 10000) / 10,
		now + index,
		now + index,
	);

	if (isTv) seedTvBranch(inserts, id, index, now);
	else seedMovieBranch(inserts, id, index, now);

	inserts.insertMetadataGenre.run(id, `genre-${index % 10}`);
	inserts.insertCast.run(id, `person-${index % 50}`, 0);
	inserts.insertMetadataCollection.run(id, `col-${index % 5}`, index);
	if (index % 3 === 0) inserts.insertMetadataImage.run(id, BENCHMARK_IMAGE_ID);
}

/** TV branch: seasons + episodes + per-episode media files — gives the TV detail endpoint (seasons/episodes/files enrichment) real weight. */
function seedTvBranch(inserts: CatalogInserts, id: string, index: number, now: number): void {
	const seasonCount = 2 + (index % 2);
	const episodeCount = EPISODES_BASE + (index % 5);
	for (let seasonIndex = 0; seasonIndex < seasonCount; seasonIndex++) {
		const seasonId = `season-${index}-${seasonIndex}`;
		inserts.insertSeason.run(seasonId, seasonId, id, seasonIndex + 1, `Season ${seasonIndex + 1}`, now + index, now + index);
		for (let episodeIndex = 0; episodeIndex < episodeCount; episodeIndex++) {
			const episodeId = `ep-${index}-${seasonIndex}-${episodeIndex}`;
			inserts.insertEpisode.run(
				episodeId,
				episodeId,
				seasonId,
				episodeIndex + 1,
				`Episode S${seasonIndex + 1}E${episodeIndex + 1}`,
				now + index,
				now + index,
			);
			inserts.insertMediaFile.run(
				`mf-${episodeId}`,
				id,
				episodeId,
				null,
				`/benchmark/library/ep-${index}-${seasonIndex}-${episodeIndex}.mkv`,
				`ep-${episodeIndex}.mkv`,
				1800,
				now + index,
				now + index,
			);
		}
	}
}

function seedMovieBranch(inserts: CatalogInserts, id: string, index: number, now: number): void {
	inserts.insertMovie.run(`movie-${id}`, id, id, now + index, now + index);
	inserts.insertMediaFile.run(
		`mf-${id}`,
		id,
		`movie-${id}`,
		null,
		`/benchmark/library/movie-${index}.mkv`,
		`movie-${index}.mkv`,
		6000,
		now + index,
		now + index,
	);
}

/**
 * Seeds per-profile state (watchlist, playback progress, watched history,
 * ratings, notifications) for every simulated client so the personalized
 * endpoints (continue-watching, insights, unread-count, watchlist) carry real
 * data instead of empty responses. All rows are deterministic (index math, no
 * RNG) so runs are reproducible. The worker users and profiles themselves come
 * from the launcher's identity seeding.
 */
export function seedServerProfiles(database: Database, workerCount: number, rows: number): void {
	database.run("PRAGMA foreign_keys = OFF");
	database.run("BEGIN");

	const now = Math.floor(Date.now() / 1000);
	const inserts = prepareProfileInserts(database);

	for (let worker = 0; worker < workerCount; worker++) {
		seedProfileWatchlistAndRatings(inserts, worker, rows, now);
		seedProfileProgress(inserts, worker, rows, now);
		seedProfileHistory(inserts, worker, rows, now);
		seedProfileNotifications(inserts, worker, now);
	}

	database.run("COMMIT");
	// Bulk-seeded data has no statistics yet; without them the planner sorts the
	// paginated browse path instead of using the composite indexes.
	database.run("ANALYZE");
	database.run("PRAGMA foreign_keys = ON");
}

function prepareProfileInserts(database: Database) {
	return {
		insertWatchlist: database.prepare(
			"INSERT OR IGNORE INTO watchlist (id, profile_id, metadata_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		),
		insertProgress: database.prepare(
			"INSERT OR IGNORE INTO playback_progress (id, profile_id, media_file_id, position, duration, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		),
		insertHistory: database.prepare(
			"INSERT INTO watched_history (id, media_file_id, profile_id, duration_watched, is_full_watch, watched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		),
		insertRating: database.prepare(
			"INSERT OR IGNORE INTO user_ratings (id, profile_id, metadata_id, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		),
		insertNotification: database.prepare(
			// The notifications table mixes column casings: `userId` is camelCase,
			// `profile_id`/`read_at` are snake_case — match the schema exactly.
			"INSERT INTO notifications (id, userId, profile_id, type, title, message, data, read_at, created_at, updated_at) VALUES (?, ?, ?, 'system', ?, NULL, '{}', ?, ?, ?)",
		),
	};
}

type ProfileInserts = ReturnType<typeof prepareProfileInserts>;

function seedProfileWatchlistAndRatings(inserts: ProfileInserts, worker: number, rows: number, now: number): void {
	const profileId = `profile-bench-${worker}`;

	for (let i = 0; i < WATCHLIST_PER_PROFILE; i++) {
		const metadataIndex = (worker * 131 + i * 7) % rows;
		inserts.insertWatchlist.run(
			`wl-bench-${worker}-${i}`,
			profileId,
			`meta-${String(metadataIndex).padStart(7, "0")}`,
			now - i * 60,
			now - i * 60,
		);
	}

	for (let i = 0; i < RATINGS_PER_PROFILE; i++) {
		const metadataIndex = (worker * 173 + i * 11) % rows;
		inserts.insertRating.run(
			`rating-bench-${worker}-${i}`,
			profileId,
			`meta-${String(metadataIndex).padStart(7, "0")}`,
			(i % 10) + 1,
			now - i * 3_600,
			now - i * 3_600,
		);
	}
}

function seedProfileProgress(inserts: ProfileInserts, worker: number, rows: number, now: number): void {
	const profileId = `profile-bench-${worker}`;

	// In-progress movies (index falls back +1 onto a movie when it hits a TV slot).
	for (let i = 0; i < IN_PROGRESS_MOVIES_PER_PROFILE; i++) {
		let metadataIndex = (worker * 97 + i * 13) % rows;
		if (metadataIndex % TV_SHOW_CYCLE === 0) metadataIndex = (metadataIndex + 1) % rows;

		inserts.insertProgress.run(
			`prog-bench-${worker}-${i}`,
			profileId,
			`mf-meta-${String(metadataIndex).padStart(7, "0")}`,
			1000 + ((i * 977) % 3000),
			6000,
			0,
			now - i * 3_600,
			now - i * 3_600,
		);
	}

	// TV next-episode paths: last episode completed, the one before it in progress.
	for (let i = 0; i < TV_PROGRESS_SHOWS_PER_PROFILE; i++) {
		const showIndex = (i * TV_SHOW_CYCLE + worker) * TV_SHOW_CYCLE;
		if (showIndex >= rows) break;

		const seasonCount = 2 + (showIndex % 2);
		const episodeCount = EPISODES_BASE + (showIndex % 5);
		const lastSeason = seasonCount - 1;
		inserts.insertProgress.run(
			`prog-tv-bench-${worker}-${i}-last`,
			profileId,
			`mf-ep-${showIndex}-${lastSeason}-${episodeCount - 1}`,
			1800,
			1800,
			1,
			now - i * 7_200,
			now - i * 7_200,
		);
		inserts.insertProgress.run(
			`prog-tv-bench-${worker}-${i}-prev`,
			profileId,
			`mf-ep-${showIndex}-${lastSeason}-${episodeCount - 2}`,
			700,
			1800,
			0,
			now - i * 7_200 - 60,
			now - i * 7_200 - 60,
		);
	}
}

/**
 * Watched history spread over ~90 days — feeds the insights aggregations,
 * which range-filter `watched_at`.
 */
function seedProfileHistory(inserts: ProfileInserts, worker: number, rows: number, now: number): void {
	const profileId = `profile-bench-${worker}`;

	for (let i = 0; i < HISTORY_PER_PROFILE; i++) {
		let metadataIndex = (worker * 211 + i * 17) % rows;
		if (metadataIndex % TV_SHOW_CYCLE === 0) metadataIndex = (metadataIndex + 1) % rows;

		const watchedAtSeconds = now - ((i * 6 * 3600) % (90 * 24 * 3600));
		inserts.insertHistory.run(
			`hist-bench-${worker}-${i}`,
			`mf-meta-${String(metadataIndex).padStart(7, "0")}`,
			profileId,
			2400 + ((i * 613) % 3600),
			1,
			watchedAtSeconds,
			watchedAtSeconds,
			watchedAtSeconds,
		);
	}
}

function seedProfileNotifications(inserts: ProfileInserts, worker: number, now: number): void {
	const profileId = `profile-bench-${worker}`;
	const userId = `user-bench-${worker}`;

	for (let i = 0; i < NOTIFICATIONS_PER_PROFILE; i++) {
		const read = i >= UNREAD_NOTIFICATIONS;
		const readAt = read ? now - i * 3_600 : null;
		inserts.insertNotification.run(
			`notif-bench-${worker}-${i}`,
			userId,
			profileId,
			`Benchmark notification ${i}`,
			readAt,
			now - i * 3_600,
			now - i * 3_600,
		);
	}
}
