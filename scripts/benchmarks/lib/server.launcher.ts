import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profilerFlags, spawnManagedProcess, stringField, waitForHealth } from "benchkit";
import { makeSignature } from "better-auth/crypto";
import { file, spawnSync } from "bun";
import { DatabaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { removeTree } from "@/utils/directory.utils";
import { BENCHMARK_IMAGE_ID, seedServerCatalog, seedServerProfiles } from "./seed.utils";

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
	/** Stage a minimal web dist (index.html + one immutable asset) and serve it. */
	withWebDist?: boolean | undefined;
}

const DATABASE_FILE = "reelvault.sqlite";

export const SETUP_TOKEN = "reelvault-benchmark-setup-token-0123456789";
export const AUTH_SECRET = "reelvault-benchmark-auth-secret-0123456789";

/** Admin credentials the auth benchmark logs in with (route multiplier makes the login limit a non-issue). */
export const BENCH_USER = { name: "Benchmark Admin", email: "benchmark@reelvault.local", password: "benchmark-password-123" };
const STARTUP_TIMEOUT_MS = 120_000;
const HEALTH_POLL_MS = 300;
const SAMPLE_MEDIA_SECONDS = 30;
/** Synthetic source bitrate so the startup benchmark can force a bitrate-capped transcode. */
const SAMPLE_MEDIA_BITRATE = 4_000_000;
/** 128x192 purple PNG — a real decodable poster so load tests exercise the image pipeline. */
const BENCHMARK_POSTER_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAIAAAADACAIAAABDBPzwAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACjUlEQVR4nO3VSREDQRADwYVjTIOpQBuGHp0RQlC6vveL3g7Ch/6bRpABMaDLLdSAGNA8hhrQHIQJ6qZ8QAxoHkMNaA7CBHVTPiAGNI+hBjQHYYK6KR8QA5rHUAOagzBB3ZQPiAHNY6gBzUGYoG7KB8SA5jHUgOYgTFA35QNiQPMYakBzECaom/IBMaB5DDWgOQgT1E35gBjQPIYa0ByECeqmfEAMaB5DDWgOwgR1Uz4gBjSPoQY0B2GCuikfEAOax1ADmoMwQd2UD4gBzWOoAc1BmKBuygfEgOYx1IDmIExQN+UDYkDzGGpAcxAmqJvyATGgeQw1oDkIE9RN+YAY0DyGGtAchAnqpnxADGgeQw1oDsIEdVM+IAY0j6EGNAdhgropHxADmsdQA5qDMEHdlA+IAc1jqAHNQZigbsoHxIDmMdSA5iBMUDflA2JA8xhqQHMQJqib8gExoHkMNaA5CBPUTfmAGNA8hhrQHIQJ6qZ8QAxoHkMNaA7CBHVTPiAGNI+hBjQHYYK6KR8QA5rHUAOagzBB3ZQPiAHNY6gBzUGYoG7KB8SA5jHUgOYgTFA35QNiQPMYakBzECaom/IBMaB5DDWgOQgT1E35gBjQPIYa0ByECeqmfEAMaB5DDWgOwgR1Uz4gBjSPoQY0B2GCuikfEAOax1ADmoMwQd2UD4gBzWOoAc1BmKBuygfEgOYx1IDmIExQN+UDYkDzGGpAcxAmqJvyATGgeQw1oDkIE9RN+YAY0DyGGtAchAnqpnxADGgeQw1oDsIEdVM+IAY0j6EGNAdhgropHxADmsdQA5qDMEHdlA+IAc1jqAHNQZigbsoHxIDmMdSA5iBMUDflA2JA8xhqQHMQJqg5i4n+F3FF7AYuVFkAAAAASUVORK5CYII=";

/** Absolute path of the reelvault repo — cwd for spawned/migrated server processes. */
export const repoRoot = join(import.meta.dir, "..", "..", "..");

export function serverEnv(port: number, rootDir: string, webDist?: string): Record<string, string> {
	return {
		...process.env,
		APP_PORT: String(port),
		ROOT_DIR: rootDir,
		// Must match the file the launcher seeds; never inherit a parent override.
		DB_FILE_NAME: DATABASE_FILE,
		// Empty string means unset for resolveWebDistRoot — API-only mode unless a
		// dist was explicitly staged for the static-serving scenarios.
		APP_WEB_DIST: webDist ?? "",
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

/** Migrates the server's database and seeds the catalog and the load-test settings before the server boots. */
function prepareDatabase(rootDir: string, rows: number): void {
	const factory = new DatabaseFactory(join(rootDir, DATABASE_FILE));
	try {
		factory.migrate();
		const posterPath = join(rootDir, "benchmark-poster.png");
		writeFileSync(posterPath, Buffer.from(BENCHMARK_POSTER_PNG_BASE64, "base64"));
		seedServerCatalog(factory.sqlite, rows, posterPath);
		seedBenchSettings(factory.sqlite);
	} finally {
		factory.shutdown();
	}
}

/**
 * Seeds the rate-limit SYSTEM SETTINGS to their load-test ceilings. The env
 * hatches (REELVAULT_RATE_LIMIT_*) stopped working when these limits moved
 * into the settings store (server.config.ts reads the store live), so without
 * this row the benchmark measures the limiter's 1000 req/min/IP instead of the
 * server. Multiplier clamps at its definition max (10_000).
 */
function seedBenchSettings(database: Database): void {
	const now = Math.floor(Date.now() / 1000);
	const upsert = database.prepare("INSERT OR REPLACE INTO system_settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)");
	upsert.run("network.rateLimit.globalMax", "1000000", now, now);
	upsert.run("network.rateLimit.routeMultiplier", "10000", now, now);
	if (process.env.REELVAULT_BENCH_FORCE_SOFTWARE === "true") upsert.run("ffmpeg.hwaccel", "none", now, now);
}

/** Registers the generated sample clip in the catalog and returns its media-file id. */
async function registerSampleMedia(rootDir: string, samplePath: string): Promise<string> {
	const database = new Database(join(rootDir, DATABASE_FILE));
	const now = Math.floor(Date.now() / 1000);
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
			"INSERT INTO media_files (id, library_id, metadata_id, movie_id, file_path, file_name, duration, file_size, bit_rate, is_default, created_at, updated_at) VALUES ('mf-sample', 'lib-benchmark', 'meta-sample', 'movie-sample', ?, 'sample.mp4', ?, ?, ?, 1, ?, ?)",
		)
		.run(samplePath, SAMPLE_MEDIA_SECONDS, (await file(samplePath).stat()).size, SAMPLE_MEDIA_BITRATE, now, now);
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

/** The setup endpoint creates an implicit profile for the admin; playback endpoints need its id as x-profile-id. */
async function resolveAdminProfileId(baseUrl: string, cookie: string): Promise<string> {
	const response = await fetch(`${baseUrl}/v1/profiles?page=1&limit=1`, { headers: { cookie } });
	if (!response.ok) throw new Error(`Profile lookup failed: HTTP ${response.status}`);

	const body: unknown = await response.json();
	const data: unknown = typeof body === "object" && body !== null && "data" in body ? body.data : undefined;
	const profileId = Array.isArray(data) ? stringField(data[0], "id") : undefined;
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
	const database = new Database(join(rootDir, DATABASE_FILE));
	const now = Math.floor(Date.now() / 1000);
	const expiresAt = now + 24 * 60 * 60;
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
		const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
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
 * Stages a minimal SPA dist so the static-serving suite exercises the real
 * web-static plugin: an index.html with a <head> (meta-tag injection path),
 * one immutable hashed-style asset sized like a real JS bundle, and the
 * version.json the UI version probe reads. Returns the directory to serve.
 */
async function stageWebDist(rootDir: string): Promise<string> {
	const webDist = join(rootDir, "web-dist");
	await mkdir(join(webDist, "assets"), { recursive: true });
	await writeFile(
		join(webDist, "index.html"),
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ReelVault Benchmark</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
	);
	const assetChunk = "reelvault-benchmark-asset-0123456789abcdef;".repeat(1024);
	await writeFile(join(webDist, "assets", "app.js"), Buffer.from(assetChunk, "utf8").subarray(0, 64 * 1024));
	await writeFile(join(webDist, "version.json"), JSON.stringify({ version: "1.0.0-benchmark" }));

	return webDist;
}

/** Seeds the per-profile state of the worker identities into the running server's database. */
function seedProfiles(rootDir: string, workerCount: number, rows: number): void {
	const database = new Database(join(rootDir, DATABASE_FILE));
	try {
		seedServerProfiles(database, workerCount, rows);
	} finally {
		database.close();
	}
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

	const seedRows = options.seedRows ?? 5_000;
	console.log(`[server] migrating and seeding ${seedRows} rows in ${rootDir}...`);
	prepareDatabase(rootDir, seedRows);

	let sampleMediaPath = "";
	if (options.withSampleMedia) {
		const generated = generateSampleMedia(rootDir);
		if (generated) sampleMediaPath = generated;
	}

	const webDist = options.withWebDist ? await stageWebDist(rootDir) : undefined;

	console.log(`[server] starting on port ${port}...`);
	// Under `bun run benchmark --profile`, every server writes CPU and heap profiles.
	const profileFlags = profilerFlags(`server-${port}`);

	// Optional CPU pinning for simulated low-end runs; the benchmark bootstrap
	// probes taskset before setting this, so an unsupported host never reaches it.
	const affinity = process.platform === "linux" ? process.env.REELVAULT_BENCH_CPU_AFFINITY?.trim() : undefined;
	const affinityPrefix = affinity ? ["taskset", "-c", affinity] : [];

	const serverProcess = spawnManagedProcess({
		cmd: [...affinityPrefix, process.execPath, ...profileFlags, "src/index.ts"],
		cwd: repoRoot,
		env: serverEnv(port, rootDir, webDist),
		logPath: join(rootDir, "server.log"),
	});

	const baseUrl = `http://127.0.0.1:${port}`;
	try {
		await waitForHealth(`${baseUrl}/v1/health`, { timeoutMs: STARTUP_TIMEOUT_MS, pollMs: HEALTH_POLL_MS });
		const cookie = await createAdminAndLogin(baseUrl);
		const workerCount = options.workerCount ?? 1;
		const workerCookies = await seedWorkerIdentities(rootDir, workerCount);
		seedProfiles(rootDir, workerCount, seedRows);
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
			// Deterministic from seedServerCatalog: library + the first TV show's first
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
				await removeTree(rootDir);
			},
		};
	} catch (error) {
		await serverProcess.stop();
		await removeTree(rootDir);
		throw error;
	}
}
