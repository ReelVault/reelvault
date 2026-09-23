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
		expect(indexes.has("metadata_updated_at_idx")).toBe(true);
		expect(indexes.has("media_files_updated_at_idx")).toBe(true);
		expect(indexes.has("admin_audit_action_created_idx")).toBe(true);
		expect(indexes.has("worker_operations_status_created_idx")).toBe(true);
		expect(indexes.has("plugin_repositories_url_unique")).toBe(true);
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
		} finally {
			legacy.shutdown();
		}
	});
});
