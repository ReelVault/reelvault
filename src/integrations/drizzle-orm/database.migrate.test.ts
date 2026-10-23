import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeSync } from "@/utils/directory.utils";
import { DatabaseFactory } from "./database.factory";

const root = mkdtempSync(join(tmpdir(), "reelvault-migrate-"));
const migrationsFolder = join(root, "migrations");
const created: DatabaseFactory[] = [];

/** Two migrations: the second rebuilds `parents` the way released rebuild migrations do. */
const FIXTURE_MIGRATIONS: Record<string, string> = {
	"20260101000000_create_parents": [
		"CREATE TABLE `parents` (`id` text PRIMARY KEY NOT NULL, `label` text NOT NULL);",
		"--> statement-breakpoint",
		"CREATE TABLE `children` (`id` text PRIMARY KEY NOT NULL, `parent_id` text NOT NULL REFERENCES `parents`(`id`) ON DELETE cascade);",
		"--> statement-breakpoint",
		"INSERT INTO `parents` (`id`, `label`) VALUES ('parent-1', 'kept');",
		"--> statement-breakpoint",
		"INSERT INTO `children` (`id`, `parent_id`) VALUES ('child-1', 'parent-1');",
	].join("\n"),
	"20260102000000_rebuild_parents": [
		"PRAGMA foreign_keys=OFF;",
		"--> statement-breakpoint",
		"CREATE TABLE `parents_next` (`id` text PRIMARY KEY NOT NULL, `label` text NOT NULL);",
		"--> statement-breakpoint",
		"INSERT INTO `parents_next` SELECT `id`, `label` FROM `parents`;",
		"--> statement-breakpoint",
		"DROP TABLE `parents`;",
		"--> statement-breakpoint",
		"ALTER TABLE `parents_next` RENAME TO `parents`;",
		"--> statement-breakpoint",
		"PRAGMA foreign_keys=ON;",
	].join("\n"),
};

beforeAll(() => {
	for (const [name, sql] of Object.entries(FIXTURE_MIGRATIONS)) {
		mkdirSync(join(migrationsFolder, name), { recursive: true });
		writeFileSync(join(migrationsFolder, name, "migration.sql"), sql);
	}
});

afterAll(() => {
	for (const factory of created) factory.shutdown();

	removeTreeSync(root);
});

function migratedFactory(name: string): DatabaseFactory {
	const factory = new DatabaseFactory(join(root, `${name}.sqlite`));
	created.push(factory);
	factory.migrate(migrationsFolder);

	return factory;
}

describe("DatabaseFactory.migrate", () => {
	test("keeps child rows when a later migration rebuilds their parent table", () => {
		const factory = migratedFactory("rebuild-keeps-children");

		const children = factory.sqlite.query("SELECT id, parent_id AS parentId FROM children").all();

		expect(children).toEqual([{ id: "child-1", parentId: "parent-1" }]);
	});

	test("turns foreign keys back on after the migrations ran", () => {
		const factory = migratedFactory("foreign-keys-restored");

		expect(factory.sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
	});
});
