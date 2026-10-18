import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/app/http/middleware/domain-errors.middleware";
import { useTestDatabase } from "../helpers/test-database.helper";

const [{ auth }, { mediaFilesRoutes }, { episodesRoutes }, { librariesRoutes }] = await Promise.all([
	import("@/integrations/better-auth/better-auth.config"),
	import("@/app/http/routes/v1/media-files.routes"),
	import("@/app/http/routes/v1/episodes.routes"),
	import("@/app/http/routes/v1/libraries.routes"),
]);

const testDatabase = useTestDatabase();

const app = new Elysia().use(domainErrorsMiddleware).use(mediaFilesRoutes).use(episodesRoutes).use(librariesRoutes);

const originalGetSession = auth.api.getSession;
const originalUserHasPermission = auth.api.userHasPermission;

afterEach(() => {
	auth.api.getSession = originalGetSession;
	auth.api.userHasPermission = originalUserHasPermission;
});

const NOW = "CAST(strftime('%s','now') AS INTEGER)";

/** Rows the relation assertions read. Each test gets its own migrated database, so the seed runs before every test. */
const SEED = [
	`INSERT INTO libraries (id, name, type, metadata_storage_mode, created_at, updated_at) VALUES
		('lib-movies', 'Filmy', 'movies', 'database', ${NOW}, ${NOW}),
		('lib-tv', 'Seriale', 'tv_shows', 'database', ${NOW}, ${NOW})`,
	`INSERT INTO library_paths (id, library_id, stable_key, path, is_active, metadata_storage_mode, created_at, updated_at) VALUES
		('lp-1', 'lib-movies', 'sk-lp-1', '/media/filmy', 1, NULL, ${NOW}, ${NOW})`,
	`INSERT INTO media_files (id, library_id, metadata_id, movie_id, episode_id, file_path, file_name, format_name, is_default, is_enabled, created_at, updated_at) VALUES
		('mf-library', 'lib-movies', 'meta-1', 'mov-2', NULL, '/media/filmy/library.mkv', 'library.mkv', 'matroska', 1, 1, ${NOW}, ${NOW}),
		('mf-movie', 'lib-movies', 'meta-2', 'mov-1', NULL, '/media/filmy/movie.mkv', 'movie.mkv', 'matroska', 1, 1, ${NOW}, ${NOW}),
		('mf-episode', 'lib-movies', 'meta-3', NULL, 'ep-1', '/media/filmy/episode.mkv', 'episode.mkv', 'matroska', 1, 1, ${NOW}, ${NOW})`,
	`INSERT INTO media_file_video_streams (media_file_id, "index", codec_name, width, height, is_default, is_forced) VALUES
		('mf-library', 0, 'h264', 1920, 1080, 1, 0)`,
	`INSERT INTO media_file_audio_streams (media_file_id, "index", codec_name, channels, is_default, is_forced) VALUES
		('mf-library', 0, 'aac', 2, 1, 0)`,
	`INSERT INTO subtitles (id, media_file_id, language, label, format, type, file_path, stream_index, is_default, is_forced, created_at, updated_at) VALUES
		('sub-1', 'mf-library', 'pl', 'Polski', 'srt', 'external', '/media/filmy/library.srt', NULL, 1, 0, ${NOW}, ${NOW})`,
	`INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES
		('mov-1', 'sk-mov-1', 'meta-2', ${NOW}, ${NOW}),
		('mov-2', 'sk-mov-2', 'meta-1', ${NOW}, ${NOW})`,
	`INSERT INTO seasons (id, stable_key, metadata_id, image_id, season_number, name, overview, air_date, status, created_at, updated_at) VALUES
		('sea-1', 'sk-sea-1', 'meta-3', NULL, 1, 'Season 1', NULL, NULL, NULL, ${NOW}, ${NOW})`,
	`INSERT INTO episodes (id, stable_key, season_id, image_id, type, episode_number, absolute_number, title, overview, air_date, created_at, updated_at) VALUES
		('ep-1', 'sk-ep-1', 'sea-1', NULL, 'regular', 1, NULL, 'Pilot', NULL, NULL, ${NOW}, ${NOW})`,
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
	beforeEach(async () => {
		const client = testDatabase.client();
		// The relation fixtures join by id only: parents such as metadata rows are not seeded, and some rows
		// reference parents inserted later in SEED. CHECK constraints stay on, so every row is still valid.
		await client.run(sql.raw("PRAGMA foreign_keys = OFF"));
		for (const statement of SEED) await client.run(sql.raw(statement));

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

	test("media-files list items carry library + streams + subtitles relations", async () => {
		const { status, body } = await getJson("/media-files?page=1&limit=10");
		expect(status).toBe(200);

		const libraryFile = (body.data as Array<Record<string, unknown>>).find((file) => file.id === "mf-library");
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
		const mediaFiles = episode?.mediaFiles as Array<{ fileName: string }>;
		expect(mediaFiles.map((file) => file.fileName)).toContain("episode.mkv");
	});

	test("library list carries paths; mediaFiles load only when requested via fields", async () => {
		const { status, body } = await getJson("/libraries?page=1&limit=10");
		expect(status).toBe(200);

		const library = (body.data as Array<Record<string, unknown>>).find((row) => row.id === "lib-movies");
		const paths = library?.paths as Array<{ path: string }>;
		expect(paths.map((entry) => entry.path)).toContain("/media/filmy");

		// Field projection returns exactly the requested keys, so `id` must ride along.
		const withFiles = await getJson("/libraries?page=1&limit=10&fields=id,mediaFiles");
		expect(withFiles.status).toBe(200);
		const libraryWithFiles = (withFiles.body.data as Array<Record<string, unknown>>).find((row) => row.id === "lib-movies");
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
