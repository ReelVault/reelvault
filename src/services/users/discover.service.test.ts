import { beforeEach, describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { clearRecommendationFeatureStats } from "@/repositories/discover-recommendations.reader";
import { insertMovieMediaFile, insertSeriesEpisode } from "../../../tests/helpers/media.fixture";
import {
	insertGenres,
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

/** A provider genre, so the title has a feature row the recommendation pipeline can vectorize. */
async function linkGenre(metadataId: string, name: string): Promise<void> {
	const client = db.client();
	await insertGenres(client, { id: `genre-${name}`, stableKey: `genre-${name}`, name });
	await client.insert(schema.metadataGenres).values({ metadataId, genreId: `genre-${name}` });
}

beforeEach(async () => {
	discoverService.clearCache();
	clearRecommendationFeatureStats();
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
		await linkGenre("meta-liked", "Drama");
		await watch(hated, 1);
		await watch(liked, 1);
		await rate("profile-1", "meta-hated", 0);

		const result = await discoverService.getDiscoverView({ limit: 10 }, "profile-1");

		expect(result.recommendations.map((item) => item.id)).toEqual(["meta-liked"]);
		expect(result.trending.map((item) => item.id)).toEqual(["meta-liked"]);
		expect(result.recommendedMovies?.map((item) => item.id)).toEqual(["meta-liked"]);
		expect(result.recommendedShows).toEqual([]);
		expect(result.recommendationReasons).toEqual([{ metadataId: "meta-liked", kind: "popular" }]);
	});

	test("keeps a reason for every title the sliced movie, show and combined rows serve", async () => {
		await seedMovie("meta-a", 90);
		await seedMovie("meta-b", 80);
		const show = await insertSeriesEpisode(db.client(), null);
		await linkGenre("meta-a", "Drama");
		await linkGenre("meta-b", "Comedy");
		await linkGenre(show.metadataId, "Crime");

		const result = await discoverService.getDiscoverView({ limit: 1 }, "profile-1");
		const served = [...result.recommendations, ...(result.recommendedMovies ?? []), ...(result.recommendedShows ?? [])];
		const reasonIds = new Set(result.recommendationReasons?.map((reason) => reason.metadataId));

		expect(result.recommendedMovies).toHaveLength(1);
		expect(result.recommendedShows?.map((item) => item.id)).toEqual([show.metadataId]);
		expect(served.every((item) => reasonIds.has(item.id))).toBe(true);
		expect(reasonIds.size).toBe(new Set(served.map((item) => item.id)).size);
	});

	test("a requested limit of one returns one recently added movie", async () => {
		await seedMovie("meta-a", 10);
		await seedMovie("meta-b", 20);

		const result = await discoverService.getDiscoverView({ limit: 1 }, "profile-1");

		expect(result.recentlyAddedMovies).toHaveLength(1);
		expect(result.recentlyAddedShows).toHaveLength(0);
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
