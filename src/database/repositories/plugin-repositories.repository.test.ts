import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { pluginRepositoriesRepository } from "@/database/repositories/plugin-repositories.repository";

const client = databaseFactory.getClient();

beforeAll(async () => {
	await client.run(
		sql.raw(`
			CREATE TABLE IF NOT EXISTS plugin_repositories (
				id TEXT PRIMARY KEY NOT NULL,
				name TEXT NOT NULL,
				url TEXT NOT NULL,
				token_encrypted TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				last_refreshed_at INTEGER,
				last_error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`),
	);
	await client.run(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS plugin_repositories_url_unique ON plugin_repositories (url)"));
});

beforeEach(async () => {
	await client.delete(pluginRepositoriesRepository.table);
});

describe("PluginRepositoriesRepository.createIfAbsent", () => {
	test("seeds once and tolerates a concurrent duplicate instead of throwing", async () => {
		// Regression: two parallel first requests to the admin repositories
		// endpoint each seeded the official repository, and the second insert hit
		// the unique url index → 500 on a cold server.
		await Promise.all([
			pluginRepositoriesRepository.createIfAbsent({ name: "Official", url: "https://example.com/catalog.json" }),
			pluginRepositoriesRepository.createIfAbsent({ name: "Official", url: "https://example.com/catalog.json" }),
		]);

		const rows = await pluginRepositoriesRepository.list();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.url).toBe("https://example.com/catalog.json");
	});

	test("create still rejects a duplicate url", async () => {
		await pluginRepositoriesRepository.create({ name: "Official", url: "https://example.com/catalog.json" });

		await expect(pluginRepositoriesRepository.create({ name: "Duplicate", url: "https://example.com/catalog.json" })).rejects.toThrow();
	});
});
