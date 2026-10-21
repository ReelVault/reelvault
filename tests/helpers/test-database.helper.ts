import { afterEach, beforeEach, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { removeTreeSync } from "@/utils/directory.utils";

/**
 * Gives every test in the calling file its own migrated SQLite database and routes the
 * shared `databaseFactory` to it. Call once at the top level of a test file; the
 * returned `client` reads the current test's database for seeding and assertions, and
 * `sqlite` is the raw handle for the statements the query builder cannot express.
 */
export function useTestDatabase(): {
	client: () => ReturnType<DatabaseFactory["getClient"]>;
	sqlite: () => DatabaseFactory["sqlite"];
} {
	let factory: DatabaseFactory | undefined;
	let tempDir = "";
	let spies: Array<{ mockRestore(): void }> = [];

	const current = (): DatabaseFactory => {
		if (!factory) throw new Error("The test database is only available inside a test");

		return factory;
	};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "rv-test-db-"));
		factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
		factory.migrate();
		spies = [
			spyOn(databaseFactory, "getClient").mockImplementation((options) => current().getClient(options)),
			spyOn(databaseFactory, "transaction").mockImplementation((callback, options) => current().transaction(callback, options)),
		];
	});

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		factory = undefined;
		removeTreeSync(tempDir);
	});

	return { client: () => current().getClient(), sqlite: () => current().sqlite };
}
