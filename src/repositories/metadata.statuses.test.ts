import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTreeSync } from "@/utils/directory.utils";
import { metadataRepository } from "./metadata.repository";

/**
 * The catalog status list feeds the status filter, so it must hold each status once, without blanks,
 * in a stable order.
 */

const tempDirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
let factory: DatabaseFactory;

beforeEach(() => {
	const tempDir = mkdtempSync(join(tmpdir(), "rv-statuses-"));
	tempDirs.push(tempDir);
	factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
	factory.migrate();
	spies.push(spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)));
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const dir of tempDirs.splice(0)) removeTreeSync(dir);
});

describe("metadataRepository.findDistinctStatuses", () => {
	test("returns each non-empty status once, sorted", async () => {
		await factory
			.getClient()
			.insert(schema.metadata)
			.values([
				{ id: "status-1", stableKey: "status-key-1", title: "One", type: "tv_show", releaseDate: "2001-01-01", status: "Returning Series" },
				{ id: "status-2", stableKey: "status-key-2", title: "Two", type: "tv_show", releaseDate: "2002-01-01", status: "Ended" },
				{ id: "status-3", stableKey: "status-key-3", title: "Three", type: "movie", releaseDate: "2003-01-01", status: "Ended" },
				{ id: "status-4", stableKey: "status-key-4", title: "Four", type: "movie", releaseDate: "2004-01-01", status: "" },
				{ id: "status-5", stableKey: "status-key-5", title: "Five", type: "movie", releaseDate: "2005-01-01", status: null },
			]);

		expect(await metadataRepository.findDistinctStatuses()).toEqual(["Ended", "Returning Series"]);
	});

	test("returns no statuses for an empty catalog", async () => {
		await expect(metadataRepository.findDistinctStatuses()).resolves.toEqual([]);
	});
});
