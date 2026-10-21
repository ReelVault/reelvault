import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTreeSync } from "@/utils/directory.utils";
import { imageRepository } from "./images.repository";
import { profilesRepository } from "./profiles.repository";

/**
 * The auth hot path caches each profile for a few seconds. A new avatar must replace the cached copy once
 * its write has committed, so the previous avatar is never served after the change.
 */

const IMAGE_URL = /^\/v1\/images\//;

const tempDirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
let factory: DatabaseFactory;

beforeEach(() => {
	const tempDir = mkdtempSync(join(tmpdir(), "rv-avatar-cache-"));
	tempDirs.push(tempDir);
	factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
	factory.migrate();
	spies.push(
		spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)),
		spyOn(databaseFactory, "transaction").mockImplementation((callback, options) => factory.transaction(callback, options)),
	);
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const dir of tempDirs.splice(0)) removeTreeSync(dir);
});

describe("profile avatar and the auth profile cache", () => {
	test("a new avatar is visible to the cached profile read as soon as the write has committed", async () => {
		const client = factory.getClient();
		await client.insert(schema.users).values({ id: "user-avatar", name: "Ann", email: "ann-avatar@example.test", emailVerified: true });
		await client.insert(schema.profiles).values({ id: "profile-avatar", userId: "user-avatar", name: "Ann" });
		expect((await profilesRepository.findByPrimaryIdCached("profile-avatar"))?.avatarUrl).toBeNull();

		await imageRepository.replaceProfileAvatar("profile-avatar", {
			localPath: join(tempDirs[0] ?? tmpdir(), "avatar.webp"),
			contentType: "image/webp",
			width: 64,
			height: 64,
			fileSize: 100,
			sourceHash: "avatar-hash",
			stableKey: "avatar-profile-avatar",
		});

		expect((await profilesRepository.findByPrimaryIdCached("profile-avatar"))?.avatarUrl).toMatch(IMAGE_URL);
	});
});
