import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@/utils/directory.utils";
import { CatalogSchemaBuilder } from "./catalog-schema.builder";

describe("CatalogSchemaBuilder", () => {
	test("replays each migration's SQL in name order and skips a directory without one", async () => {
		const migrationsRoot = await mkdtemp(join(tmpdir(), "reelvault-migrations-"));
		// The names are created in reverse order, so a lister that keeps the read order is very unlikely to pass.
		const names = ["20260106_without_sql", "20260105_fifth", "20260104_fourth", "20260103_third", "20260102_second", "20260101_first"];
		await Promise.all(names.map((name) => mkdir(join(migrationsRoot, name), { recursive: true })));
		await Promise.all([
			writeFile(
				join(migrationsRoot, "20260101_first", "migration.sql"),
				"CREATE TABLE catalog_items (id INTEGER PRIMARY KEY, label TEXT);--> statement-breakpoint\nINSERT INTO catalog_items (label) VALUES ('from-first');",
			),
			writeFile(join(migrationsRoot, "20260102_second", "migration.sql"), "INSERT INTO catalog_items (label) VALUES ('from-second');"),
			writeFile(join(migrationsRoot, "20260103_third", "migration.sql"), "INSERT INTO catalog_items (label) VALUES ('from-third');"),
			writeFile(join(migrationsRoot, "20260104_fourth", "migration.sql"), "INSERT INTO catalog_items (label) VALUES ('from-fourth');"),
			writeFile(join(migrationsRoot, "20260105_fifth", "migration.sql"), "INSERT INTO catalog_items (label) VALUES ('from-fifth');"),
			writeFile(join(migrationsRoot, "20260106_without_sql", "index.ts"), "export {};"),
		]);

		try {
			const database = new Database(":memory:");
			await new CatalogSchemaBuilder({ migrationDirectory: () => migrationsRoot }).createSchema(database);

			const rows = database.query("SELECT label FROM catalog_items ORDER BY id").all();
			expect(rows).toEqual([
				{ label: "from-first" },
				{ label: "from-second" },
				{ label: "from-third" },
				{ label: "from-fourth" },
				{ label: "from-fifth" },
			]);
			database.close();
		} finally {
			await removeTree(migrationsRoot);
		}
	});
});
