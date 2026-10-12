import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/database/database";
import { CORE_ARTIFACTS_OWNER } from "@/modules/artifacts/artifacts.constants";
import { trickplayRepository } from "./trickplay.repository";

const tempDirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const NOW = 1_700_000_000;

type Value = string | number | null;

type Insert = (sqlText: string, values: Value[]) => unknown;

/** Seeds a small library: one movie with a preview, one playable movie without a preview, one episode, one unplayable movie. */
function seed(db: DatabaseFactory["sqlite"]): void {
	const insert: Insert = (sqlText, values) => db.run(sqlText, values);
	seedLibrariesAndTitles(insert);
	seedMediaFiles(insert);
	seedWorkerRuns(insert);
}

function seedLibrariesAndTitles(insert: Insert): void {
	insert("INSERT INTO libraries (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
		"lib-movies",
		"Movies",
		"movies",
		NOW,
		NOW,
	]);
	insert("INSERT INTO libraries (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
		"lib-shows",
		"Shows",
		"tv_shows",
		NOW,
		NOW,
	]);
	insert("INSERT INTO metadata (id, stable_key, title, type, release_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
		"title-movie",
		"stable-movie",
		"Alpha",
		"movie",
		"2001-01-01",
		NOW,
		NOW,
	]);
	insert("INSERT INTO metadata (id, stable_key, title, type, release_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
		"title-extra",
		"stable-extra",
		"Gamma",
		"movie",
		"2003-01-01",
		NOW,
		NOW,
	]);
	insert("INSERT INTO metadata (id, stable_key, title, type, release_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
		"title-show",
		"stable-show",
		"Beta",
		"tv_show",
		"2002-01-01",
		NOW,
		NOW,
	]);
	insert("INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
		"movie-1",
		"stable-movie-1",
		"title-movie",
		NOW,
		NOW,
	]);
	insert("INSERT INTO movies (id, stable_key, metadata_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
		"movie-2",
		"stable-movie-2",
		"title-extra",
		NOW,
		NOW,
	]);
	insert("INSERT INTO seasons (id, stable_key, metadata_id, season_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
		"season-1",
		"stable-season-1",
		"title-show",
		1,
		NOW,
		NOW,
	]);
	insert("INSERT INTO episodes (id, stable_key, season_id, episode_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
		"episode-1",
		"stable-episode-1",
		"season-1",
		1,
		NOW,
		NOW,
	]);
}

function seedMediaFiles(insert: Insert): void {
	const mediaFile =
		"INSERT INTO media_files (id, library_id, metadata_id, movie_id, episode_id, file_path, file_name, duration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
	insert(mediaFile, ["file-movie", "lib-movies", "title-movie", "movie-1", null, "/m/alpha.mkv", "alpha.mkv", 5400, NOW, NOW]);
	insert(mediaFile, ["file-episode", "lib-shows", "title-show", null, "episode-1", "/s/beta-s1e1.mkv", "beta-s1e1.mkv", 1500, NOW, NOW]);
	insert(mediaFile, ["file-no-duration", "lib-movies", "title-extra", "movie-2", null, "/m/gamma.mkv", "gamma.mkv", null, NOW, NOW]);

	insert(
		"INSERT INTO media_artifacts (id, stable_key, media_file_id, plugin_id, kind, content_type, storage_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			"artifact-movie",
			"stable-artifact-movie",
			"file-movie",
			CORE_ARTIFACTS_OWNER,
			"trickplay",
			"image/webp",
			"trickplay/file-movie.webp",
			NOW,
			NOW,
		],
	);
}

function seedWorkerRuns(insert: Insert): void {
	insert(
		"INSERT INTO worker_operations (id, type, status, cancel_requested, total_items, pending_items, running_items, completed_items, failed_items, cancelled_items, retention_until, created_at, updated_at) VALUES (?,?,?,0,0,0,0,0,0,0,?,?,?)",
		["op-regen", "trickplay-generate", "completed", null, NOW, NOW],
	);
	insert(
		"INSERT INTO worker_operations (id, type, status, cancel_requested, total_items, pending_items, running_items, completed_items, failed_items, cancelled_items, retention_until, created_at, updated_at) VALUES (?,?,?,0,0,0,0,0,0,0,?,?,?)",
		["op-other", "trickplay-generate", "completed", null, NOW, NOW],
	);

	const job =
		"INSERT INTO worker_jobs (id, worker_id, operation_id, data, status, result, run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
	insert(job, [
		"job-1",
		"trickplay-generate",
		"op-regen",
		"{}",
		"completed",
		'{"mediaFileId":"file-movie","frames":10,"sprites":1}',
		NOW,
		NOW,
		NOW,
	]);
	insert(job, [
		"job-2",
		"trickplay-generate",
		"op-regen",
		"{}",
		"completed",
		'{"mediaFileId":"file-episode","frames":0,"sprites":0,"skipped":"storage-budget"}',
		NOW,
		NOW,
		NOW,
	]);
	insert(job, [
		"job-3",
		"trickplay-generate",
		"op-regen",
		"{}",
		"completed",
		'{"mediaFileId":"file-no-duration","frames":0,"sprites":0,"skipped":"no-duration"}',
		NOW,
		NOW,
		NOW,
	]);
	insert(job, ["job-4", "trickplay-generate", "op-regen", "{}", "failed", null, NOW, NOW, NOW]);
	insert(job, ["job-5", "trickplay-generate", "op-regen", "{}", "pending", null, NOW, NOW, NOW]);
	insert(job, ["job-6", "trickplay-generate", "op-regen", "{}", "cancelled", null, NOW, NOW, NOW]);
	insert(job, [
		"job-7",
		"trickplay-generate",
		"op-other",
		"{}",
		"completed",
		'{"mediaFileId":"file-movie","frames":3,"sprites":1}',
		NOW,
		NOW,
		NOW,
	]);
}

beforeEach(() => {
	const tempDir = mkdtempSync(join(tmpdir(), "rv-trickplay-repo-"));
	tempDirs.push(tempDir);
	const factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
	factory.migrate();
	spies.push(
		spyOn(databaseFactory, "transaction").mockImplementation((callback, options) => factory.transaction(callback, options)),
		spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)),
	);
	seed(factory.sqlite);
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("trickplayRepository regeneration scope", () => {
	test("without force only playable files with no core previews are matched", async () => {
		expect(await trickplayRepository.findMediaFileIdsForRegeneration({ kind: "all" }, false, 50)).toEqual(["file-episode"]);
	});

	test("force also matches files that already have previews", async () => {
		expect(await trickplayRepository.findMediaFileIdsForRegeneration({ kind: "all" }, true, 50)).toEqual(["file-episode", "file-movie"]);
	});

	test("library, title and season scopes narrow the match", async () => {
		expect(await trickplayRepository.findMediaFileIdsForRegeneration({ kind: "library", id: "lib-movies" }, true, 50)).toEqual([
			"file-movie",
		]);
		expect(await trickplayRepository.findMediaFileIdsForRegeneration({ kind: "title", id: "title-show" }, true, 50)).toEqual([
			"file-episode",
		]);
		expect(await trickplayRepository.findMediaFileIdsForRegeneration({ kind: "season", id: "season-1" }, true, 50)).toEqual([
			"file-episode",
		]);
		expect(await trickplayRepository.findMediaFileIdsForRegeneration({ kind: "season", id: "season-2" }, true, 50)).toEqual([]);
	});

	test("the cap limits the list while the count still reports every match", async () => {
		expect(await trickplayRepository.findMediaFileIdsForRegeneration({ kind: "all" }, true, 1)).toEqual(["file-episode"]);
		expect(await trickplayRepository.countForRegeneration({ kind: "all" }, true)).toBe(2);
	});
});

describe("trickplayRepository.countRegenerationOutcomes", () => {
	test("groups one operation's jobs by status and skip reason", async () => {
		const rows = await trickplayRepository.countRegenerationOutcomes("op-regen");
		const counts = Object.fromEntries(rows.map((row) => [`${row.status}|${row.skipped ?? ""}`, row.count]));

		expect(counts).toEqual({
			"completed|": 1,
			"completed|storage-budget": 1,
			"completed|no-duration": 1,
			"failed|": 1,
			"pending|": 1,
			"cancelled|": 1,
		});
	});
});
