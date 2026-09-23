import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { MetadataWithRelation } from "@reelvault/sdk/common";
import { discoverRepository } from "@/database/repositories/discover.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { discoverService } from "./discover.service";

type CatalogItem = Awaited<ReturnType<typeof discoverRepository.findRecommendationCandidates>>["catalog"][number];

const mockImage: MetadataWithRelation["images"][number] = {
	imageType: "poster",
	data: {
		id: "img-1",
		stableKey: "img-key-1",
		localPath: "/images/img-1.jpg",
		contentType: "image/jpeg",
		width: 1000,
		height: 1500,
		fileSize: 50000,
		optimizationVersion: 1,
		createdAt: new Date(),
		updatedAt: new Date(),
	},
};

function createMockCatalogItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
	return {
		id: "meta-rec-1",
		stableKey: "key-rec-1",
		primaryProviderId: null,
		title: "Rec 1",
		originalTitle: null,
		overview: null,
		tagline: null,
		type: "movie",
		status: null,
		releaseDate: "2024-01-01",
		originCountry: null,
		budget: null,
		revenue: null,
		popularity: 100,
		matchScore: null,
		hasMissingTranslation: false,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function createMockMetadataWithRelation(id: string): MetadataWithRelation {
	return {
		id,
		stableKey: `key-${id}`,
		primaryProviderId: null,
		title: `Hydrated ${id}`,
		sortTitle: null,
		numberingMode: null,
		originalTitle: null,
		overview: null,
		tagline: null,
		type: "movie",
		status: null,
		releaseDate: "2024-01-01",
		originCountry: null,
		budget: null,
		revenue: null,
		popularity: 50,
		matchScore: null,
		hasMissingTranslation: false,
		createdAt: new Date(),
		updatedAt: new Date(),
		collections: [],
		companies: [],
		genres: [],
		keywords: [],
		cast: [],
		crew: [],
		images: [mockImage],
		rating: { avgScore: 8, scores: [] },
		providers: [],
		lockedFields: [],
	};
}

describe("DiscoverService", () => {
	beforeEach(() => {
		discoverService.clearCache();
	});

	test("throws NotFoundError when profileId is missing", async () => {
		await expect(discoverService.getDiscoverView({ limit: 10 }, undefined)).rejects.toThrow("Profile not found: auth");
	});

	test("hydrates missing recommendations and trending items with relations", async () => {
		spyOn(metadataRepository, "findRecentlyAddedByType").mockResolvedValue([]);
		spyOn(discoverRepository, "findRecentlyWatchedByOthers").mockResolvedValue([{ metadataId: "meta-trending-1", playCount: 5 }]);
		spyOn(discoverRepository, "findRecommendationCandidates").mockResolvedValue({
			watched: [],
			ratings: [],
			watchlist: [],
			catalog: [createMockCatalogItem({ id: "meta-rec-1", title: "Rec 1", popularity: 100 })],
		});
		spyOn(discoverRepository, "findPlaybackCompletionSignals").mockResolvedValue([]);

		const findManyByIdsWithRelationsSpy = spyOn(metadataRepository, "findManyByIdsWithRelations").mockImplementation(async (ids) =>
			ids.map((id) => createMockMetadataWithRelation(id)),
		);

		const result = await discoverService.getDiscoverView({ limit: 10 }, "profile-1");

		expect(findManyByIdsWithRelationsSpy).toHaveBeenCalled();
		expect(result.recommendations.length).toBe(1);
		expect(result.recommendations[0]?.images).toEqual([mockImage]);
		expect(result.trending.length).toBe(1);
		expect(result.trending[0]?.images).toEqual([mockImage]);
	});
});
