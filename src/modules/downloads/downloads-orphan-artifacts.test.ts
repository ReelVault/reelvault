import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTreeSync } from "@/utils/directory.utils";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { downloadsService } from "./downloads.service";

const db = useTestDatabase();
const KNOWN_ID = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const ORPHAN_ID = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c";
const FOREIGN_DIRECTORY = "not-a-download";
const CREATED = [KNOWN_ID, ORPHAN_ID, FOREIGN_DIRECTORY];

function pathOf(name: string): string {
	return join(serverConfig.paths.downloads, name);
}

/** One profile owning one media file, which the known download belongs to. */
async function seedDownloadOwner(): Promise<void> {
	const client = db.client();
	await client.insert(schema.users).values({ id: "user-1", name: "Ann", email: "ann@example.com", emailVerified: true });
	await client.insert(schema.profiles).values({ id: "profile-1", userId: "user-1", name: "Ann" });
	await client.insert(schema.libraries).values({ id: "lib-1", name: "Movies", type: "movies" });
	await client
		.insert(schema.metadata)
		.values({ id: "meta-1", stableKey: "movie-heat", title: "Heat", type: "movie", releaseDate: "1995-12-15" });
	await client.insert(schema.movies).values({ id: "movie-1", stableKey: "movie-heat", metadataId: "meta-1" });
	await client.insert(schema.mediaFiles).values({
		id: "file-1",
		libraryId: "lib-1",
		metadataId: "meta-1",
		movieId: "movie-1",
		fileName: "Heat.mkv",
		filePath: "/media/heat.mkv",
		size: 1_000,
		duration: 3_600,
		isDefault: true,
	});
}

describe("DownloadsService.sweepOrphanArtifacts", () => {
	beforeEach(async () => {
		for (const name of CREATED) mkdirSync(pathOf(name), { recursive: true });
		await seedDownloadOwner();
	});

	afterEach(() => {
		for (const name of CREATED) removeTreeSync(pathOf(name));
	});

	test("removes the directories of deleted downloads and keeps the rest", async () => {
		await db.client().insert(schema.downloads).values({ id: KNOWN_ID, profileId: "profile-1", mediaFileId: "file-1" });

		const result = await downloadsService.sweepOrphanArtifacts();

		expect(result).toEqual({ removed: 1 });
		expect(existsSync(pathOf(KNOWN_ID))).toBe(true);
		expect(existsSync(pathOf(ORPHAN_ID))).toBe(false);
		expect(existsSync(pathOf(FOREIGN_DIRECTORY))).toBe(true);
	});
});
