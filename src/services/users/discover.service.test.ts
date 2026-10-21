import { beforeEach, describe, expect, test } from "bun:test";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import {
	insertProfiles,
	insertUserRatings,
	insertUsers,
	insertWatchedHistory,
	updateMetadataPopularity,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { discoverService } from "./discover.service";

const db = useTestDatabase();

async function seedAccounts(): Promise<void> {
	await insertUsers(db.client(), [
		{ id: "user-1", name: "Viewer", email: "viewer@example.com", emailVerified: true },
		{ id: "user-2", name: "Other", email: "other@example.com", emailVerified: true },
	]);
	await insertProfiles(db.client(), [
		{ id: "profile-1", userId: "user-1", name: "Viewer" },
		{ id: "profile-2", userId: "user-2", name: "Other" },
	]);
}

/** Adds a movie with the given popularity and returns its media file id. */
async function seedMovie(metadataId: string, popularity: number): Promise<string> {
	const client = db.client();
	const mediaFileId = await insertMovieMediaFile(client, `/media/${metadataId}.mkv`, metadataId);
	await updateMetadataPopularity(client, metadataId, popularity);

	return mediaFileId;
}

/** Records `times` watches of a media file by another profile, inside the trending window. */
async function watch(mediaFileId: string, times: number): Promise<void> {
	const now = new Date();
	for (let i = 0; i < times; i++) {
		await insertWatchedHistory(db.client(), {
			id: crypto.randomUUID(),
			mediaFileId,
			profileId: "profile-2",
			durationWatched: 120,
			isFullWatch: false,
			watchedAt: now,
			createdAt: now,
			updatedAt: now,
		});
	}
}

async function rate(profileId: string, metadataId: string, rating: number): Promise<void> {
	const now = new Date();
	await insertUserRatings(db.client(), { id: crypto.randomUUID(), profileId, metadataId, rating, createdAt: now, updatedAt: now });
}

beforeEach(async () => {
	discoverService.clearCache();
	await seedAccounts();
});

describe("DiscoverService", () => {
	test("throws UnauthorizedError when profileId is missing", async () => {
		await expect(discoverService.getDiscoverView({ limit: 10 }, undefined)).rejects.toMatchObject({
			category: "unauthorized",
			code: "auth.profile_required",
		});
	});

	test("keeps a disliked title out of recommendations and out of trending built from watches", async () => {
		const hated = await seedMovie("meta-hated", 100);
		const liked = await seedMovie("meta-liked", 50);
		await watch(hated, 1);
		await watch(liked, 1);
		await rate("profile-1", "meta-hated", 0);

		const result = await discoverService.getDiscoverView({ limit: 10 }, "profile-1");

		expect(result.recommendations.map((item) => item.id)).toEqual(["meta-liked"]);
		expect(result.trending.map((item) => item.id)).toEqual(["meta-liked"]);
	});

	test("ranks a title with more plays above a more popular title with fewer plays", async () => {
		const hot = await seedMovie("meta-hot", 10);
		const popular = await seedMovie("meta-popular", 100);
		await watch(hot, 3);
		await watch(popular, 1);

		const result = await discoverService.getDiscoverView({ limit: 10 }, "profile-1");

		expect(result.trending.map((item) => item.id)).toEqual(["meta-hot", "meta-popular"]);
	});
});
