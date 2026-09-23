import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnManagedProcess, waitForHealth } from "benchkit";
import { makeSignature } from "better-auth/crypto";
import { file, spawnSync } from "bun";

export interface ManagedServer {
	/** Temp data dir the spawned server runs from (ROOT_DIR) — scenario scripts may stage files there. */
	readonly rootDir: string;
	readonly port: number;
	/** OS process id of the spawned server (for external memory sampling). */
	readonly pid: number;
	readonly baseUrl: string;
	/** Session cookie for authenticated requests ("better-auth.session_token=..."). */
	readonly cookie: string;
	/** One session cookie per simulated client, so per-identity limits scale with concurrency. */
	readonly workerCookies: readonly string[];
	/** Profile id of the simulated client (send as x-profile-id for playback). */
	profileIdFor(workerIndex: number): string;
	/** Profile id of the logged-in admin user (send as x-profile-id when using `cookie`). */
	readonly adminProfileId: string;
	/** Fake client IP for the simulated client (send as x-forwarded-for). */
	ipFor(workerIndex: number): string;
	/** Id of the seeded benchmark poster image (exercises GET /v1/images). */
	readonly benchmarkImageId: string;
	/** A seeded movie metadata id (exercises GET /v1/metadata/:id detail). */
	readonly benchmarkMovieDetailId: string;
	/** A seeded tv_show metadata id with seasons/episodes (heaviest detail GET). */
	readonly benchmarkTvDetailId: string;
	/** A seeded movie media-file id (exercises GET /v1/playback-sessions/view). */
	readonly benchmarkMediaFileId: string;
	/** Seeded catalog ids for the list/detail endpoints that take path params. */
	readonly benchmarkLibraryId: string;
	readonly benchmarkSeasonId: string;
	readonly benchmarkEpisodeId: string;
	readonly benchmarkGenreId: string;
	readonly benchmarkPersonId: string;
	/** Number of catalog rows seeded (lets scenarios scale, e.g. deep pages). */
	readonly seededRows: number;
	/** Path of the generated sample media file (empty when unavailable). */
	readonly sampleMediaPath: string;
	readonly sampleMediaId?: string | undefined;
	stop(): Promise<void>;
}

export interface StartServerOptions {
	port?: number | undefined;
	seedRows?: number | undefined;
	/** Number of simulated client identities to seed (at least the max concurrency level). */
	workerCount?: number | undefined;
	/** Keep the spawned server alive after stop() (debugging aid). */
	keepServer?: boolean | undefined;
	/** Generate an ffmpeg test-clip and register it in the catalog. */
	withSampleMedia?: boolean | undefined;
}

const SETUP_TOKEN = "reelvault-benchmark-setup-token-0123456789";
const AUTH_SECRET = "reelvault-benchmark-auth-secret-0123456789";

/** Admin credentials the auth benchmark logs in with (route multiplier makes the login limit a non-issue). */
export const BENCH_USER = { name: "Benchmark Admin", email: "benchmark@reelvault.local", password: "benchmark-password-123" };
const STARTUP_TIMEOUT_MS = 120_000;
const HEALTH_POLL_MS = 300;
const SAMPLE_MEDIA_SECONDS = 30;
const BENCHMARK_IMAGE_ID = "img-benchmark";
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
/** 128x192 purple PNG — a real decodable poster so load tests exercise the image pipeline. */
const BENCHMARK_POSTER_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAIAAAADACAIAAABDBPzwAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACjUlEQVR4nO3VSREDQRADwYVjTIOpQBuGHp0RQlC6vveL3g7Ch/6bRpABMaDLLdSAGNA8hhrQHIQJ6qZ8QAxoHkMNaA7CBHVTPiAGNI+hBjQHYYK6KR8QA5rHUAOagzBB3ZQPiAHNY6gBzUGYoG7KB8SA5jHUgOYgTFA35QNiQPMYakBzECaom/IBMaB5DDWgOQgT1E35gBjQPIYa0ByECeqmfEAMaB5DDWgOwgR1Uz4gBjSPoQY0B2GCuikfEAOax1ADmoMwQd2UD4gBzWOoAc1BmKBuygfEgOYx1IDmIExQN+UDYkDzGGpAcxAmqJvyATGgeQw1oDkIE9RN+YAY0DyGGtAchAnqpnxADGgeQw1oDsIEdVM+IAY0j6EGNAdhgropHxADmsdQA5qDMEHdlA+IAc1jqAHNQZigbsoHxIDmMdSA5iBMUDflA2JA8xhqQHMQJqib8gExoHkMNaA5CBPUTfmAGNA8hhrQHIQJ6qZ8QAxoHkMNaA7CBHVTPiAGNI+hBjQHYYK6KR8QA5rHUAOagzBB3ZQPiAHNY6gBzUGYoG7KB8SA5jHUgOYgTFA35QNiQPMYakBzECaom/IBMaB5DDWgOQgT1E35gBjQPIYa0ByECeqmfEAMaB5DDWgOwgR1Uz4gBjSPoQY0B2GCuikfEAOax1ADmoMwQd2UD4gBzWOoAc1BmKBuygfEgOYx1IDmIExQN+UDYkDzGGpAcxAmqJvyATGgeQw1oDkIE9RN+YAY0DyGGtAchAnqpnxADGgeQw1oDsIEdVM+IAY0j6EGNAdhgropHxADmsdQA5qDMEHdlA+IAc1jqAHNQZigbsoHxIDmMdSA5iBMUDflA2JA8xhqQHMQJqg5i4n+F3FF7AYuVFkAAAAASUVORK5CYII=";

const repoRoot = join(import.meta.dir, "..", "..", "..");

function serverEnv(port: number, rootDir: string): Record<string, string> {
	return {
		...process.env,
		APP_PORT: String(port),
		ROOT_DIR: rootDir,
		// Must match the file `seedCatalog` opens; never inherit a parent override.
		DB_FILE_NAME: "reelvault.sqlite",
		SETUP_TOKEN,
		BETTER_AUTH_SECRET: AUTH_SECRET,
		// The load test measures server throughput, not the abuse-protection limiter.
		REELVAULT_RATE_LIMIT_GLOBAL_MAX: "1000000",
		REELVAULT_AUTH_RATE_LIMIT_ENABLED: "false",
		REELVAULT_LOGIN_ACCOUNT_MAX_ATTEMPTS: "10000000",
		REELVAULT_RATE_LIMIT_ROUTE_MULTIPLIER: "100000",
		// Measure what ships: production defaults (no tracing, no query-logger
		// proxy, no pretty-log worker). Override with NODE_ENV=development to
		// reproduce pre-2026-09 baselines that ran with development overhead.
		NODE_ENV: process.env.NODE_ENV ?? "production",
	} satisfies Record<string, string>;
}

function migrateDatabase(port: number, rootDir: string): void {
	const migration = spawnSync({
		cmd: ["bun", "run", "scripts/migrate.ts"],
		cwd: repoRoot,
		env: serverEnv(port, rootDir),
		stdout: "ignore",
		stderr: "pipe",
	});
	if (migration.exitCode !== 0) throw new Error(`runtime migration failed with exit code ${migration.exitCode}`);
}

/** Seeds a realistic catalog so listing/search endpoints return non-trivial payloads. */
function seedCatalog(rootDir: string, rows: number): void {
	const database = new Database(join(rootDir, "reelvault.sqlite"));
	database.run("PRAGMA foreign_keys = OFF");
	database.run("BEGIN");

	const now = Date.now();
	database
		.prepare(
			"INSERT INTO libraries (id, name, type, metadata_storage_mode, created_at, updated_at) VALUES (?, ?, 'movies', 'database', ?, ?)",
		)
		.run("lib-benchmark", "Benchmark Movies", now, now);

	const insertMetadata = database.prepare(
		"INSERT INTO metadata (id, stable_key, title, original_title, overview, tagline, type, status, release_date, origin_country, popularity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'released', ?, 'US', ?, ?, ?)",
	);
	const insertMovie = database.prepare("INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
	const insertMediaFile = database.prepare(
		"INSERT INTO media_files (id, library_id, metadata_id, movie_id, episode_id, file_path, file_name, duration, file_size, is_default, created_at, updated_at) VALUES (?, 'lib-benchmark', ?, ?, ?, ?, ?, ?, 4000000000, 1, ?, ?)",
	);
	const insertSeason = database.prepare(
		"INSERT INTO seasons (id, stable_key, metadata_id, season_number, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const insertEpisode = database.prepare(
		"INSERT INTO episodes (id, stable_key, season_id, episode_number, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const insertGenre = database.prepare("INSERT INTO genres (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
	const insertMetadataGenre = database.prepare("INSERT INTO metadata_genres (metadata_id, genre_id) VALUES (?, ?)");

	// One real PNG on disk + a poster link per 3rd title: gives the image route
	// (GET /v1/images) and poster joins real traffic in load tests.
	const posterPath = join(rootDir, "benchmark-poster.png");
	writeFileSync(posterPath, Buffer.from(BENCHMARK_POSTER_PNG_BASE64, "base64"));
	const insertImage = database.prepare(
		"INSERT INTO images (id, stable_key, local_path, content_type, width, height, file_size, created_at, updated_at) VALUES (?, 'benchmark-poster', ?, 'image/png', 128, 192, ?, ?, ?)",
	);
	insertImage.run(BENCHMARK_IMAGE_ID, posterPath, 731, now, now);
	const insertMetadataImage = database.prepare("INSERT INTO metadata_images (metadata_id, image_id, image_type) VALUES (?, ?, 'poster')");

	const insertPerson = database.prepare("INSERT INTO people (id, stable_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
	const insertCast = database.prepare("INSERT INTO metadata_cast (metadata_id, person_id, role, sort_order) VALUES (?, ?, 'Actor', ?)");

	for (let genreIndex = 0; genreIndex < 10; genreIndex++) {
		insertGenre.run(`genre-${genreIndex}`, `genre-${genreIndex}`, `Genre ${genreIndex}`, now, now);
	}

	for (let personIndex = 0; personIndex < 50; personIndex++) {
		insertPerson.run(`person-${personIndex}`, `person-${personIndex}`, `Actor ${personIndex}`, now, now);
	}

	for (let index = 0; index < rows; index++) {
		const id = `meta-${String(index).padStart(7, "0")}`;
		const isTv = index % TV_SHOW_CYCLE === 0;
		const title = index % 5 === 0 ? `Star Odyssey ${index}` : `Benchmark Title ${index}`;
		insertMetadata.run(
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

		if (isTv) {
			// TV branch: seasons + episodes + per-episode media files — gives the
			// TV detail endpoint (seasons/episodes/files enrichment) real weight.
			const seasonCount = 2 + (index % 2);
			const episodeCount = EPISODES_BASE + (index % 5);
			for (let seasonIndex = 0; seasonIndex < seasonCount; seasonIndex++) {
				const seasonId = `season-${index}-${seasonIndex}`;
				insertSeason.run(seasonId, seasonId, id, seasonIndex + 1, `Season ${seasonIndex + 1}`, now + index, now + index);
				for (let episodeIndex = 0; episodeIndex < episodeCount; episodeIndex++) {
					const episodeId = `ep-${index}-${seasonIndex}-${episodeIndex}`;
					insertEpisode.run(
						episodeId,
						episodeId,
						seasonId,
						episodeIndex + 1,
						`Episode S${seasonIndex + 1}E${episodeIndex + 1}`,
						now + index,
						now + index,
					);
					insertMediaFile.run(
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
		} else {
			insertMovie.run(`movie-${id}`, id, id, now + index, now + index);
			insertMediaFile.run(
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

		insertMetadataGenre.run(id, `genre-${index % 10}`);
		insertCast.run(id, `person-${index % 50}`, 0);
		if (index % 3 === 0) insertMetadataImage.run(id, BENCHMARK_IMAGE_ID);
	}

	database.run("COMMIT");
	database.close();
}

/**
 * Seeds per-profile state (watchlist, playback progress, watched history,
 * ratings, notifications) for every simulated client so the personalized
 * endpoints (continue-watching, insights, unread-count, watchlist) carry real
 * data instead of empty responses. All rows are deterministic (index math, no
 * RNG) so runs are reproducible.
 */
function seedProfileData(rootDir: string, workerCount: number, rows: number): void {
	const database = new Database(join(rootDir, "reelvault.sqlite"));
	database.run("PRAGMA foreign_keys = OFF");
	database.run("BEGIN");

	const now = Date.now();

	const insertWatchlist = database.prepare(
		"INSERT OR IGNORE INTO watchlist (id, profile_id, metadata_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
	);
	const insertProgress = database.prepare(
		"INSERT OR IGNORE INTO playback_progress (id, profile_id, media_file_id, position, duration, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const insertHistory = database.prepare(
		"INSERT INTO watched_history (id, media_file_id, profile_id, duration_watched, is_full_watch, watched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const insertRating = database.prepare(
		"INSERT OR IGNORE INTO user_ratings (id, profile_id, metadata_id, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const insertNotification = database.prepare(
		// The notifications table mixes column casings: `userId` is camelCase,
		// `profile_id`/`read_at` are snake_case — match the schema exactly.
		"INSERT INTO notifications (id, userId, profile_id, type, title, message, data, read_at, created_at, updated_at) VALUES (?, ?, ?, 'system', ?, NULL, '{}', ?, ?, ?)",
	);

	for (let worker = 0; worker < workerCount; worker++) {
		const profileId = `profile-bench-${worker}`;
		const userId = `user-bench-${worker}`;

		for (let i = 0; i < WATCHLIST_PER_PROFILE; i++) {
			const metadataIndex = (worker * 131 + i * 7) % rows;
			insertWatchlist.run(
				`wl-bench-${worker}-${i}`,
				profileId,
				`meta-${String(metadataIndex).padStart(7, "0")}`,
				now - i * 60_000,
				now - i * 60_000,
			);
		}

		for (let i = 0; i < RATINGS_PER_PROFILE; i++) {
			const metadataIndex = (worker * 173 + i * 11) % rows;
			insertRating.run(
				`rating-bench-${worker}-${i}`,
				profileId,
				`meta-${String(metadataIndex).padStart(7, "0")}`,
				(i % 10) + 1,
				now - i * 3_600_000,
				now - i * 3_600_000,
			);
		}

		// In-progress movies (index falls back +1 onto a movie when it hits a TV slot).
		for (let i = 0; i < IN_PROGRESS_MOVIES_PER_PROFILE; i++) {
			let metadataIndex = (worker * 97 + i * 13) % rows;
			if (metadataIndex % TV_SHOW_CYCLE === 0) metadataIndex = (metadataIndex + 1) % rows;

			insertProgress.run(
				`prog-bench-${worker}-${i}`,
				profileId,
				`mf-meta-${String(metadataIndex).padStart(7, "0")}`,
				1000 + ((i * 977) % 3000),
				6000,
				0,
				now - i * 3_600_000,
				now - i * 3_600_000,
			);
		}

		// TV next-episode paths: last episode completed, the one before it in progress.
		for (let i = 0; i < TV_PROGRESS_SHOWS_PER_PROFILE; i++) {
			const showIndex = (i * TV_SHOW_CYCLE + worker) * TV_SHOW_CYCLE;
			if (showIndex >= rows) break;

			const seasonCount = 2 + (showIndex % 2);
			const episodeCount = EPISODES_BASE + (showIndex % 5);
			const lastSeason = seasonCount - 1;
			insertProgress.run(
				`prog-tv-bench-${worker}-${i}-last`,
				profileId,
				`mf-ep-${showIndex}-${lastSeason}-${episodeCount - 1}`,
				1800,
				1800,
				1,
				now - i * 7_200_000,
				now - i * 7_200_000,
			);
			insertProgress.run(
				`prog-tv-bench-${worker}-${i}-prev`,
				profileId,
				`mf-ep-${showIndex}-${lastSeason}-${episodeCount - 2}`,
				700,
				1800,
				0,
				now - i * 7_200_000 - 60_000,
				now - i * 7_200_000 - 60_000,
			);
		}

		// Watched history spread over ~90 days — feeds the insights aggregations.
		// `watched_at` is a drizzle timestamp (SECONDS) and is range-filtered by
		// insights, so it must land in the real epoch-second window.
		for (let i = 0; i < HISTORY_PER_PROFILE; i++) {
			let metadataIndex = (worker * 211 + i * 17) % rows;
			if (metadataIndex % TV_SHOW_CYCLE === 0) metadataIndex = (metadataIndex + 1) % rows;

			const watchedAtSeconds = Math.floor(now / 1000) - ((i * 6 * 3600) % (90 * 24 * 3600));
			insertHistory.run(
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

		for (let i = 0; i < NOTIFICATIONS_PER_PROFILE; i++) {
			const read = i >= UNREAD_NOTIFICATIONS;
			const readAt = read ? now - i * 3_600_000 : null;
			insertNotification.run(
				`notif-bench-${worker}-${i}`,
				userId,
				profileId,
				`Benchmark notification ${i}`,
				readAt,
				now - i * 3_600_000,
				now - i * 3_600_000,
			);
		}
	}

	database.run("COMMIT");
	// Bulk-seeded data has no statistics yet; without them the planner sorts the
	// paginated browse path instead of using the composite indexes.
	database.run("ANALYZE");
	database.close();
}

/** Registers the generated sample clip in the catalog and returns its media-file id. */
async function registerSampleMedia(rootDir: string, samplePath: string): Promise<string> {
	const database = new Database(join(rootDir, "reelvault.sqlite"));
	const now = Date.now();
	database
		.prepare(
			"INSERT INTO metadata (id, stable_key, title, original_title, overview, tagline, type, status, release_date, origin_country, popularity, created_at, updated_at) VALUES ('meta-sample', 'meta-sample', 'Sample Clip', 'Sample Clip', 'ffmpeg test clip', 'sample', 'movie', 'released', '2024-01-01', 'US', 50, ?, ?)",
		)
		.run(now, now);
	database
		.prepare(
			"INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES ('movie-sample', 'movie-sample', 'meta-sample', ?, ?)",
		)
		.run(now, now);
	database
		.prepare(
			"INSERT INTO media_files (id, library_id, metadata_id, movie_id, file_path, file_name, duration, file_size, is_default, created_at, updated_at) VALUES ('mf-sample', 'lib-benchmark', 'meta-sample', 'movie-sample', ?, 'sample.mp4', ?, ?, 1, ?, ?)",
		)
		.run(samplePath, SAMPLE_MEDIA_SECONDS, (await file(samplePath).stat()).size, now, now);
	database.close();

	return "mf-sample";
}

function generateSampleMedia(rootDir: string): string | undefined {
	const samplePath = join(rootDir, "sample.mp4");
	const ffmpeg = spawnSync({
		cmd: [
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			`testsrc=duration=${SAMPLE_MEDIA_SECONDS}:size=640x360:rate=24`,
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=440:duration=${SAMPLE_MEDIA_SECONDS}`,
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-c:a",
			"aac",
			"-shortest",
			"-y",
			samplePath,
		],
		stdout: "ignore",
		stderr: "pipe",
	});
	if (ffmpeg.exitCode !== 0) {
		console.warn("ffmpeg sample generation failed — streaming scenario will be skipped");

		return undefined;
	}

	return samplePath;
}

/** Extracts the id of the first entry of a `{ data: [{ id }] }` JSON payload. */
function firstArrayItemId(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("data" in value)) return undefined;

	const data: unknown = value.data;
	if (!Array.isArray(data)) return undefined;

	const first: unknown = data[0];
	if (typeof first !== "object" || first === null || !("id" in first)) return undefined;

	const id: unknown = first.id;

	return typeof id === "string" ? id : undefined;
}

/** The setup endpoint creates an implicit profile for the admin; playback endpoints need its id as x-profile-id. */
async function resolveAdminProfileId(baseUrl: string, cookie: string): Promise<string> {
	const response = await fetch(`${baseUrl}/v1/profiles?page=1&limit=1`, { headers: { cookie } });
	if (!response.ok) throw new Error(`Profile lookup failed: HTTP ${response.status}`);

	const body: unknown = await response.json();
	const profileId = firstArrayItemId(body);
	if (!profileId) throw new Error("Admin user has no profile");

	return profileId;
}

async function createAdminAndLogin(baseUrl: string): Promise<string> {
	const setupResponse = await fetch(`${baseUrl}/v1/setup`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-setup-token": SETUP_TOKEN },
		body: JSON.stringify(BENCH_USER),
	});
	if (!setupResponse.ok) throw new Error(`Setup failed: HTTP ${setupResponse.status} ${await setupResponse.text()}`);

	const loginResponse = await fetch(`${baseUrl}/v1/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: BENCH_USER.email, password: BENCH_USER.password }),
	});
	if (!loginResponse.ok) throw new Error(`Login failed: HTTP ${loginResponse.status} ${await loginResponse.text()}`);

	const setCookie = loginResponse.headers.get("set-cookie");
	if (!setCookie) throw new Error("Login response contained no session cookie");

	return setCookie.split(";")[0] ?? "";
}

/**
 * Seeds one user + a pre-signed session per simulated client. Sessions are
 * signed with better-auth's own makeSignature so the server accepts the cookies
 * without any login traffic (the login endpoint itself is rate limited to
 * 5 req / 15 min and would throttle identity creation). A profile per user is
 * seeded too — playback endpoints require an x-profile-id owned by the session.
 */
async function seedWorkerIdentities(rootDir: string, count: number): Promise<string[]> {
	const database = new Database(join(rootDir, "reelvault.sqlite"));
	const now = Date.now();
	const expiresAt = now + 24 * 60 * 60 * 1000;
	const cookies: string[] = [];

	const insertUser = database.prepare(
		"INSERT INTO users (id, name, email, emailVerified, role, banned, twoFactorEnabled, created_at, updated_at) VALUES (?, ?, ?, 1, 'user', 0, 0, ?, ?)",
	);
	const insertSession = database.prepare(
		"INSERT INTO session (id, userId, token, expiresAt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const insertProfile = database.prepare("INSERT INTO profiles (id, userId, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");

	for (let index = 0; index < count; index++) {
		const userId = `user-bench-${index}`;
		const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
		const signature = await makeSignature(token, AUTH_SECRET);
		insertUser.run(userId, `Bench Worker ${index}`, `bench-worker-${index}@reelvault.local`, now, now);
		insertSession.run(`session-bench-${index}`, userId, token, expiresAt, now, now);
		insertProfile.run(`profile-bench-${index}`, userId, `Bench Profile ${index}`, now, now);
		cookies.push(`better-auth.session_token=${token}.${signature}`);
	}

	database.close();

	return cookies;
}

/**
 * Spawns an isolated ReelVault server (temp data dir + migrations + seeded
 * catalog), waits for health and returns a handle. Reuse an external server by
 * exporting BENCHMARK_BASE_URL instead.
 */
export async function startBenchmarkServer(options: StartServerOptions = {}): Promise<ManagedServer> {
	const port = options.port ?? 18472;
	const rootDir = await mkdtemp(join(tmpdir(), "reelvault-benchmark-"));
	await writeFile(join(rootDir, ".gitkeep"), "");

	console.log(`[server] migrating database in ${rootDir}...`);
	migrateDatabase(port, rootDir);
	const seedRows = options.seedRows ?? 5_000;
	seedCatalog(rootDir, seedRows);

	let sampleMediaPath = "";
	if (options.withSampleMedia) {
		const generated = generateSampleMedia(rootDir);
		if (generated) sampleMediaPath = generated;
	}

	console.log(`[server] starting on port ${port}...`);
	const serverProcess = spawnManagedProcess({
		cmd: ["bun", "run", "src/index.ts"],
		cwd: repoRoot,
		env: serverEnv(port, rootDir),
		logPath: join(rootDir, "server.log"),
	});

	const baseUrl = `http://127.0.0.1:${port}`;
	try {
		await waitForHealth(`${baseUrl}/v1/health`, { timeoutMs: STARTUP_TIMEOUT_MS, pollMs: HEALTH_POLL_MS });
		const cookie = await createAdminAndLogin(baseUrl);
		const workerCount = options.workerCount ?? 1;
		const workerCookies = await seedWorkerIdentities(rootDir, workerCount);
		seedProfileData(rootDir, workerCount, seedRows);
		const adminProfileId = await resolveAdminProfileId(baseUrl, cookie);
		let sampleMediaId: string | undefined;
		if (sampleMediaPath) sampleMediaId = await registerSampleMedia(rootDir, sampleMediaPath);

		return {
			rootDir,
			port,
			pid: serverProcess.pid,
			baseUrl,
			cookie,
			workerCookies,
			adminProfileId,
			profileIdFor: (workerIndex: number) => `profile-bench-${workerIndex}`,
			ipFor: (workerIndex: number) => `10.${Math.floor(workerIndex / 250) % 250}.${workerIndex % 250}.7`,
			benchmarkImageId: BENCHMARK_IMAGE_ID,
			// Index 1 is always a movie (0 is the first TV slot); its media file
			// exists by construction. Index 0 is always the first tv_show.
			benchmarkMovieDetailId: "meta-0000001",
			benchmarkTvDetailId: "meta-0000000",
			benchmarkMediaFileId: "mf-meta-0000001",
			// Deterministic from seedCatalog: library + the first TV show's first
			// season/episode, plus the first genre/person rows.
			benchmarkLibraryId: "lib-benchmark",
			benchmarkSeasonId: "season-0-0",
			benchmarkEpisodeId: "ep-0-0-0",
			benchmarkGenreId: "genre-1",
			benchmarkPersonId: "person-0",
			seededRows: seedRows,
			sampleMediaPath,
			sampleMediaId,
			stop: async () => {
				if (options.keepServer) {
					console.log(`[server] kept alive (root: ${rootDir}, log: ${join(rootDir, "server.log")})`);

					return;
				}

				await serverProcess.stop();
				await rm(rootDir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await serverProcess.stop();
		await rm(rootDir, { recursive: true, force: true });
		throw error;
	}
}
