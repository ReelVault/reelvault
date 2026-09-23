import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file } from "bun";
import { CatalogSchemaBuilder } from "./catalog-schema.builder";

describe("CatalogSchemaBuilder", () => {
	test("applies every migration directory's SQL in sorted order", async () => {
		const migrationsRoot = await mkdtemp(join(tmpdir(), "reelvault-migrations-"));
		await mkdir(join(migrationsRoot, "20260101_first"), { recursive: true });
		await mkdir(join(migrationsRoot, "20260102_second"), { recursive: true });
		await mkdir(join(migrationsRoot, "20260103_without_sql"), { recursive: true });
		await Promise.all([
			writeFile(
				join(migrationsRoot, "20260101_first", "migration.sql"),
				"CREATE TABLE catalog_items (id INTEGER PRIMARY KEY, label TEXT);--> statement-breakpoint\nINSERT INTO catalog_items (label) VALUES ('from-first');",
			),
			writeFile(join(migrationsRoot, "20260102_second", "migration.sql"), "INSERT INTO catalog_items (label) VALUES ('from-second');"),
			writeFile(join(migrationsRoot, "20260103_without_sql", "index.ts"), "export {};"),
		]);

		try {
			const database = new Database(":memory:");
			await new CatalogSchemaBuilder({
				migrationDirectory: () => migrationsRoot,
				listMigrationDirectories: async (directory) => {
					const entries = await readdir(directory, { withFileTypes: true });

					return entries
						.filter((entry) => entry.isDirectory())
						.map((entry) => entry.name)
						.toSorted();
				},
				readMigration: async (migrationPath) => await readFile(migrationPath, "utf8"),
				migrationExists: async (migrationPath) => await file(migrationPath).exists(),
			}).createSchema(database);

			const rows = database.query("SELECT label FROM catalog_items ORDER BY id").all();
			expect(rows).toEqual([{ label: "from-first" }, { label: "from-second" }]);
			database.close();
		} finally {
			await rm(migrationsRoot, { force: true, recursive: true });
		}
	});
});
