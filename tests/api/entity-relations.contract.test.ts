import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { databaseFactory } from "@/database/database";
import { domainErrorsMiddleware } from "@/middleware/domain-errors.middleware";

process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-32-characters";
const [{ auth }, { mediaFilesRoutes }, { episodesRoutes }, { librariesRoutes }] = await Promise.all([
	import("@/integrations/better-auth/better-auth.config"),
	import("@/api/routes/v1/media-files.routes"),
	import("@/api/routes/v1/episodes.routes"),
	import("@/api/routes/v1/libraries.routes"),
]);

const app = new Elysia().use(domainErrorsMiddleware).use(mediaFilesRoutes).use(episodesRoutes).use(librariesRoutes);

const originalGetSession = auth.api.getSession;
const originalUserHasPermission = auth.api.userHasPermission;

afterEach(() => {
	auth.api.getSession = originalGetSession;
	auth.api.userHasPermission = originalUserHasPermission;
});

const NOW = "CAST(strftime('%s','now') AS INTEGER)";

/**
 * Stub tables mirror the drizzle column NAMES exactly (drizzle selects every
 * declared column), but deliberately omit constraints — raw seed rows are the
 * only writes. Never migrate the shared test database (AGENTS.md); these
 * CREATE TABLE IF NOT EXISTS stubs are the established idiom instead.
 */
/** Drizzle `run` executes a single statement, so multi-statement scripts are arrays. */
const STUB_TABLES = [
	`CREATE TABLE IF NOT EXISTS libraries (
		id TEXT PRIMARY KEY, name TEXT, type TEXT, metadata_storage_mode TEXT, sidecar_flavor TEXT NOT NULL DEFAULT 'reelvault',
		created_at INTEGER, updated_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS library_paths (
		id TEXT PRIMARY KEY, library_id TEXT, stable_key TEXT, path TEXT,
		is_active INTEGER, metadata_storage_mode TEXT, created_at INTEGER, updated_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS media_files (
		id TEXT PRIMARY KEY, library_id TEXT, metadata_id TEXT, movie_id TEXT, episode_id TEXT,
		file_path TEXT, file_name TEXT, format_name TEXT, duration INTEGER, file_size INTEGER,
		source_mtime_ms INTEGER, bit_rate INTEGER, source TEXT, edition TEXT, quality_tag TEXT,
		is_default INTEGER, is_enabled INTEGER, created_at INTEGER, updated_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS media_file_video_streams (
		media_file_id TEXT, "index" INTEGER, codec_name TEXT, codec_long_name TEXT, profile TEXT,
		width INTEGER, height INTEGER, pixel_format TEXT, color_transfer TEXT, color_primaries TEXT,
		color_space TEXT, dovi_profile INTEGER, frame_rate TEXT, bit_rate INTEGER, language TEXT,
		title TEXT, is_default INTEGER, is_forced INTEGER,
		PRIMARY KEY (media_file_id, "index")
	)`,
	`CREATE TABLE IF NOT EXISTS media_file_audio_streams (
		media_file_id TEXT, "index" INTEGER, codec_name TEXT, codec_long_name TEXT, channels INTEGER,
		channel_layout TEXT, sample_rate INTEGER, bit_rate INTEGER, language TEXT, title TEXT,
		is_default INTEGER, is_forced INTEGER,
		PRIMARY KEY (media_file_id, "index")
	)`,
	`CREATE TABLE IF NOT EXISTS subtitles (
		id TEXT PRIMARY KEY, media_file_id TEXT, language TEXT, label TEXT, format TEXT, type TEXT,
		file_path TEXT, stream_index INTEGER, is_default INTEGER, is_forced INTEGER,
		created_at INTEGER, updated_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS movies (
		id TEXT PRIMARY KEY, stable_key TEXT, metadata_id TEXT, created_at INTEGER, updated_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS seasons (
		id TEXT PRIMARY KEY, stable_key TEXT, metadata_id TEXT, image_id TEXT,
		season_number INTEGER, name TEXT, overview TEXT, air_date TEXT, status TEXT,
		created_at INTEGER, updated_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS episodes (
		id TEXT PRIMARY KEY, stable_key TEXT, season_id TEXT, image_id TEXT, type TEXT,
		episode_number INTEGER, absolute_number INTEGER, title TEXT, overview TEXT, air_date TEXT,
		created_at INTEGER, updated_at INTEGER
	)`,
];

const SEED = [
	`INSERT OR IGNORE INTO libraries (id, name, type, metadata_storage_mode, created_at, updated_at) VALUES
		('lib-movies', 'Filmy', 'movies', 'database', ${NOW}, ${NOW}),
		('lib-tv', 'Seriale', 'tv_shows', 'database', ${NOW}, ${NOW})`,
	`INSERT OR IGNORE INTO library_paths (id, library_id, stable_key, path, is_active, metadata_storage_mode, created_at, updated_at) VALUES
		('lp-1', 'lib-movies', 'sk-lp-1', '/media/filmy', 1, NULL, ${NOW}, ${NOW})`,
	`INSERT OR IGNORE INTO media_files (id, library_id, metadata_id, movie_id, episode_id, file_path, file_name, format_name, is_default, is_enabled, created_at, updated_at) VALUES
		('mf-library', 'lib-movies', 'meta-1', NULL, NULL, '/media/filmy/library.mkv', 'library.mkv', 'matroska', 1, 1, ${NOW}, ${NOW}),
		('mf-movie', 'lib-movies', 'meta-2', 'mov-1', NULL, '/media/filmy/movie.mkv', 'movie.mkv', 'matroska', 1, 1, ${NOW}, ${NOW}),
		('mf-episode', 'lib-movies', 'meta-3', NULL, 'ep-1', '/media/filmy/episode.mkv', 'episode.mkv', 'matroska', 1, 1, ${NOW}, ${NOW})`,
	`INSERT OR IGNORE INTO media_file_video_streams (media_file_id, "index", codec_name, width, height, is_default, is_forced) VALUES
		('mf-library', 0, 'h264', 1920, 1080, 1, 0)`,
	`INSERT OR IGNORE INTO media_file_audio_streams (media_file_id, "index", codec_name, channels, is_default, is_forced) VALUES
		('mf-library', 0, 'aac', 2, 1, 0)`,
	`INSERT OR IGNORE INTO subtitles (id, media_file_id, language, label, format, type, file_path, stream_index, is_default, is_forced, created_at, updated_at) VALUES
		('sub-1', 'mf-library', 'pl', 'Polski', 'srt', 'external', '/media/filmy/library.srt', NULL, 1, 0, ${NOW}, ${NOW})`,
	`INSERT OR IGNORE INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES
		('mov-1', 'sk-mov-1', 'meta-2', ${NOW}, ${NOW})`,
	`INSERT OR IGNORE INTO seasons (id, stable_key, metadata_id, image_id, season_number, name, overview, air_date, status, created_at, updated_at) VALUES
		('sea-1', 'sk-sea-1', 'meta-3', NULL, 1, 'Season 1', NULL, NULL, NULL, ${NOW}, ${NOW})`,
	`INSERT OR IGNORE INTO episodes (id, stable_key, season_id, image_id, type, episode_number, absolute_number, title, overview, air_date, created_at, updated_at) VALUES
		('ep-1', 'sk-ep-1', 'sea-1', NULL, 'regular', 1, NULL, 'Pilot', NULL, NULL, ${NOW}, ${NOW})`,
];

const CLEANUP_ORDER = [
	"media_file_video_streams",
	"media_file_audio_streams",
	"subtitles",
	"media_files",
	"library_paths",
	"episodes",
	"seasons",
	"movies",
	"libraries",
];

/** Wraps a fake better-auth session payload so the mock matches auth.api.getSession's shape. */
function fakeGetSession(body: unknown): typeof auth.api.getSession {
	return (async () => body) as typeof auth.api.getSession;
}

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await app.handle(new Request(`http://localhost${path}`, { headers: { authorization: "Bearer test" } }));

	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The `/admin/media` honesty assertions: relation keys the SDK contract promises must reach the JSON payload. */
describe("entity relations reach API payloads", () => {
	beforeAll(async () => {
		const client = databaseFactory.getClient();
		for (const statement of STUB_TABLES) await client.run(sql.raw(statement));

		for (const table of CLEANUP_ORDER) await client.run(sql.raw(`DELETE FROM ${table}`));

		for (const statement of SEED) await client.run(sql.raw(statement));
	});

	beforeEach(() => {
		auth.api.getSession = fakeGetSession({
			user: {
				id: "user-1",
				name: "User",
				email: "user@example.com",
				emailVerified: true,
				createdAt: new Date("2026-01-02T03:04:05.000Z"),
				updatedAt: new Date("2026-01-02T03:04:05.000Z"),
				role: "user",
				banned: false,
			},
			session: { id: "session-1" },
		});
		auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;
	});

	afterAll(async () => {
		const client = databaseFactory.getClient();
		for (const table of CLEANUP_ORDER) await client.run(sql.raw(`DROP TABLE IF EXISTS ${table}`));
	});

	test("media-files list items carry library + streams + subtitles relations", async () => {
		const { status, body } = await getJson("/media-files?page=1&limit=10");
		expect(status).toBe(200);

		const libraryFile = (body.data as Array<Record<string, unknown>>).find((file) => file.id === "mf-library");
		expect(libraryFile).toBeDefined();
		expect(libraryFile?.library).toMatchObject({ id: "lib-movies", name: "Filmy", type: "movies" });
		expect(Array.isArray(libraryFile?.videoStreams) && libraryFile?.videoStreams.length === 1).toBe(true);
		expect(Array.isArray(libraryFile?.audioStreams) && libraryFile?.audioStreams.length === 1).toBe(true);
		expect(Array.isArray(libraryFile?.subtitles) && libraryFile?.subtitles.length === 1).toBe(true);
	});

	test("media-file detail carries the same relations", async () => {
		const { status, body } = await getJson("/media-files/mf-library");
		expect(status).toBe(200);
		expect(body.library).toMatchObject({ id: "lib-movies" });
		expect(body.videoStreams).toHaveLength(1);
		expect(body.audioStreams).toHaveLength(1);
		expect(body.subtitles).toHaveLength(1);
	});

	test("episode rows carry their mediaFiles relation", async () => {
		const { status, body } = await getJson("/episodes?page=1&limit=10");
		expect(status).toBe(200);

		const episode = (body.data as Array<Record<string, unknown>>).find((row) => row.id === "ep-1");
		expect(episode).toBeDefined();
		const mediaFiles = episode?.mediaFiles as Array<{ fileName: string }>;
		expect(mediaFiles.map((file) => file.fileName)).toContain("episode.mkv");
	});

	test("library list carries paths; mediaFiles load only when requested via fields", async () => {
		const { status, body } = await getJson("/libraries?page=1&limit=10");
		expect(status).toBe(200);

		const library = (body.data as Array<Record<string, unknown>>).find((row) => row.id === "lib-movies");
		expect(library).toBeDefined();
		const paths = library?.paths as Array<{ path: string }>;
		expect(paths.map((entry) => entry.path)).toContain("/media/filmy");

		// Field projection returns exactly the requested keys, so `id` must ride along.
		const withFiles = await getJson("/libraries?page=1&limit=10&fields=id,mediaFiles");
		expect(withFiles.status).toBe(200);
		const libraryWithFiles = (withFiles.body.data as Array<Record<string, unknown>>).find((row) => row.id === "lib-movies");
		expect(libraryWithFiles).toBeDefined();
		const mediaFiles = libraryWithFiles?.mediaFiles as Array<{ fileName: string }>;
		expect(mediaFiles.map((file) => file.fileName)).toContain("library.mkv");
	});

	test("library detail omits siblings by default and includes them with ?siblings=true", async () => {
		const plain = await getJson("/libraries/lib-movies");
		expect(plain.status).toBe(200);
		expect(plain.body.paths).toHaveLength(1);
		expect("siblings" in plain.body).toBe(false);

		const withSiblings = await getJson("/libraries/lib-movies?siblings=true");
		expect(withSiblings.status).toBe(200);
		const siblings = withSiblings.body.siblings as Array<{ id: string }>;
		expect(siblings.map((sibling) => sibling.id)).toContain("lib-tv");
		expect(siblings.map((sibling) => sibling.id)).not.toContain("lib-movies");
	});
});
