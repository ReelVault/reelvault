import { describe, expect, test } from "bun:test";
import { pluginRepositoriesRepository } from "@/repositories/plugin-repositories.repository";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";

// The migrated test database provides the table, its unique url index and its url check.
useTestDatabase();

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

	test("create rejects a duplicate url and keeps the original row", async () => {
		await pluginRepositoriesRepository.create({ name: "Official", url: "https://example.com/catalog.json" });

		await expect(pluginRepositoriesRepository.create({ name: "Duplicate", url: "https://example.com/catalog.json" })).rejects.toMatchObject(
			{ cause: { code: "SQLITE_CONSTRAINT_UNIQUE" } },
		);

		expect((await pluginRepositoriesRepository.list()).map((row) => row.name)).toEqual(["Official"]);
	});
});
