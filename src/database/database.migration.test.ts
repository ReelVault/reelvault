import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, MIGRATIONS_DIR } from "./database";

const root = mkdtempSync(join(tmpdir(), "reelvault-migrate-"));
const factory = new DatabaseFactory(join(root, "fresh.sqlite"));

function tableNames(f: DatabaseFactory): Set<string> {
	const rows = f.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;

	return new Set(rows.map((row) => row.name));
}

function columnNames(f: DatabaseFactory, table: string): Set<string> {
	const rows = f.sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;

	return new Set(rows.map((row) => row.name));
}

function migrationFolderNames(): string[] {
	return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.toSorted();
}

beforeAll(() => {
	factory.migrate();
});

afterAll(() => {
	factory.shutdown();
	rmSync(root, { recursive: true, force: true });
});

describe("database migrations", () => {
	test("creates the core schema and the migration ledger on a fresh database", () => {
		const tables = tableNames(factory);
		expect(tables.has("__drizzle_migrations")).toBe(true);
		expect(tables.has("system_settings")).toBe(true);
		expect(tables.has("metadata")).toBe(true);
		expect(tables.has("media_files")).toBe(true);
		expect(tables.has("worker_jobs")).toBe(true);
		expect(tables.has("scan_findings")).toBe(true);
	});

	test("creates the FTS5 search tables from the raw-SQL migration", () => {
		const tables = tableNames(factory);
		expect(tables.has("metadata_fts")).toBe(true);
		expect(tables.has("people_fts")).toBe(true);
	});

	// Regression: a hand-edited migration without `--> statement-breakpoint`
	// separators executed only its first statement under the bun-sqlite
	// migrator, silently leaving both path indexes uncreated.
	test("creates both media-file path unique indexes from the multi-episode migration", () => {
		const rows = factory.sqlite
			.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media_files'")
			.all() as Array<{ name: string; sql: string | null }>;
		const byName = new Map(rows.map((row) => [row.name, row.sql ?? ""]));

		// The legacy unconditional index is dropped in favour of the partial one —
		// real databases carried the unconditional version since the init migration.
		expect(byName.has("media_files_path_unique")).toBe(false);
		expect(byName.get("media_files_path_unlinked_unique")).toContain("WHERE");
		expect(byName.get("media_files_path_unlinked_unique")).toContain('"episode_id" IS NULL');
		expect(byName.has("media_files_path_episode_unique")).toBe(true);
	});

	test("applies the latest HDR columns", () => {
		const columns = columnNames(factory, "media_file_video_streams");
		expect(columns.has("color_transfer")).toBe(true);
		expect(columns.has("color_primaries")).toBe(true);
		expect(columns.has("color_space")).toBe(true);
		expect(columns.has("dovi_profile")).toBe(true);
	});

	test("drops the global external-id uniqueness but keeps a lookup index", () => {
		const indexes = factory.sqlite
			.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'metadata_external_ids'")
			.all() as Array<{ name: string }>;
		const names = new Set(indexes.map((index) => index.name));
		expect(names.has("metadata_external_ids_type_value_unique")).toBe(false);
		expect(names.has("metadata_external_ids_type_value_idx")).toBe(true);
	});

	test("adds the worker_jobs foreign keys and new lookup indexes", () => {
		const foreignKeys = factory.sqlite.query("PRAGMA foreign_key_list(worker_jobs)").all();
		expect(foreignKeys.length).toBeGreaterThanOrEqual(2);

		const indexes = new Set(
			(factory.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
				(index) => index.name,
			),
		);
		expect(indexes.has("admin_audit_request_idx")).toBe(true);
		expect(indexes.has("session_user_expires_idx")).toBe(true);
		expect(indexes.has("images_optimization_version_idx")).toBe(true);
	});

	test("adds the hot-path order/filter indexes and the unique catalog URL", () => {
		const indexes = new Set(
			(factory.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
				(index) => index.name,
			),
		);
		expect(indexes.has("metadata_updated_at_id_idx")).toBe(true);
		expect(indexes.has("media_files_updated_at_idx")).toBe(true);
		expect(indexes.has("admin_audit_action_created_idx")).toBe(true);
		expect(indexes.has("worker_operations_status_created_idx")).toBe(true);
		expect(indexes.has("plugin_repositories_url_unique")).toBe(true);
	});

	test("adds the index-hardening lookups and partial indexes", () => {
		const rows = factory.sqlite.query("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all() as Array<{
			name: string;
			sql: string | null;
		}>;
		const byName = new Map(rows.map((row) => [row.name, row.sql ?? ""]));

		expect(byName.has("media_files_library_id_idx")).toBe(true);
		expect(byName.has("downloads_media_file_created_idx")).toBe(true);
		expect(byName.has("metadata_type_sort_title_nocase_id_idx")).toBe(true);
		expect(byName.has("history_profile_created_idx")).toBe(true);
		expect(byName.has("subtitles_media_file_created_idx")).toBe(true);
		expect(byName.has("media_artifacts_plugin_created_idx")).toBe(true);
		expect(byName.has("worker_operations_created_idx")).toBe(true);
		expect(byName.has("worker_jobs_worker_status_created_idx")).toBe(true);
		expect(byName.has("worker_jobs_operation_created_idx")).toBe(true);
		expect(byName.has("worker_jobs_status_created_idx")).toBe(true);
		expect(byName.get("worker_jobs_running_lease_idx")).toContain("\"status\" = 'running'");
	});

	test("drops the redundant single-column prefix indexes", () => {
		const names = new Set(
			(factory.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name),
		);
		const dropped = [
			"session_user_idx",
			"media_files_library_idx",
			"media_markers_media_file_idx",
			"metadata_external_ids_metadata_idx",
			"metadata_updated_at_idx",
			"metadata_title_idx",
			"metadata_sort_title_nocase_idx",
			"metadata_match_score_idx",
			"metadata_collections_collection_idx",
			"worker_operations_status_idx",
		];
		for (const indexName of dropped) {
			expect(names.has(indexName)).toBe(false);
		}
	});

	test("keeps the FTS index in sync through the rowid triggers", () => {
		factory.sqlite.run(
			"INSERT INTO metadata (id, stable_key, title, original_title, type, release_date, popularity, has_missing_translation, created_at, updated_at) VALUES ('m1', 'm1', 'Alpha', 'Alpha', 'movie', '2024-01-01', 0, 0, 0, 0)",
		);
		const match = (term: string) =>
			factory.sqlite.query(`SELECT metadata_id FROM metadata_fts WHERE metadata_fts MATCH '${term}'`).all() as Array<{
				metadata_id: string;
			}>;

		expect(match("alpha")).toHaveLength(1);

		factory.sqlite.run("UPDATE metadata SET title = 'Beta', original_title = 'Beta' WHERE id = 'm1'");
		expect(match("alpha")).toHaveLength(0);
		expect(match("beta")).toHaveLength(1);

		factory.sqlite.run("DELETE FROM metadata WHERE id = 'm1'");
		expect(match("beta")).toHaveLength(0);
	});

	test("is idempotent and records every migration folder", () => {
		expect(() => factory.migrate()).not.toThrow();
		const applied = factory.sqlite.query("SELECT count(*) AS count FROM __drizzle_migrations").get() as { count: number };
		expect(applied.count).toBe(migrationFolderNames().length);
	});

	test("upgrades a database created from an older migration prefix", () => {
		const folders = migrationFolderNames();
		const legacyFolder = join(root, "legacy-migrations");
		// The oldest deployment state: the baseline schema only, before the raw FTS
		// migration. Upgrading must add the virtual tables the baseline cannot express.
		for (const name of folders.slice(0, 1)) {
			cpSync(join(MIGRATIONS_DIR, name), join(legacyFolder, name), { recursive: true });
		}

		const legacy = new DatabaseFactory(join(root, "legacy.sqlite"));
		try {
			legacy.migrate(legacyFolder);
			expect(tableNames(legacy).has("metadata_fts")).toBe(false);

			legacy.migrate(MIGRATIONS_DIR);

			expect(tableNames(legacy).has("metadata_fts")).toBe(true);
			expect(tableNames(legacy).has("people_fts")).toBe(true);

			// The index-hardening migration replaces the legacy unconditional path
			// unique with the partial one on databases that shipped the old index.
			const pathIndex = legacy.sqlite
				.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'media_files_path_unlinked_unique'")
				.get() as { sql: string | null } | null;
			expect(pathIndex?.sql).toContain('"episode_id" IS NULL');
		} finally {
			legacy.shutdown();
		}
	});
});
