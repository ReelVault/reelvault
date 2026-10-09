import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { downloadsRepository } from "@/database/repositories/downloads.repository";
import { serverConfig } from "@/server.config";
import { downloadsService } from "./downloads.service";

const KNOWN_ID = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const ORPHAN_ID = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c";
const FOREIGN_DIRECTORY = "not-a-download";
const CREATED = [KNOWN_ID, ORPHAN_ID, FOREIGN_DIRECTORY];

function pathOf(name: string): string {
	return join(serverConfig.paths.downloads, name);
}

describe("DownloadsService.sweepOrphanArtifacts", () => {
	beforeEach(() => {
		for (const name of CREATED) mkdirSync(pathOf(name), { recursive: true });
	});

	afterEach(() => {
		for (const name of CREATED) rmSync(pathOf(name), { recursive: true, force: true });
	});

	test("removes the directories of deleted downloads and keeps the rest", async () => {
		const findExistingIds = spyOn(downloadsRepository, "findExistingIds").mockResolvedValue(new Set([KNOWN_ID]));

		const result = await downloadsService.sweepOrphanArtifacts();

		expect(result).toEqual({ removed: 1 });
		expect(findExistingIds).toHaveBeenCalledWith(expect.arrayContaining([KNOWN_ID, ORPHAN_ID]));
		expect(existsSync(pathOf(KNOWN_ID))).toBe(true);
		expect(existsSync(pathOf(ORPHAN_ID))).toBe(false);
		expect(existsSync(pathOf(FOREIGN_DIRECTORY))).toBe(true);
		findExistingIds.mockRestore();
	});
});
