import { describe, expect, test } from "bun:test";
import { planTvShowMerge } from "./metadata-merge.repository";

describe("planTvShowMerge", () => {
	test("keeps special and regular episodes apart when their numbers collide", () => {
		const sourceSeasons = [{ id: "s-src", seasonNumber: 1 }];
		const targetSeasons = [{ id: "s-tgt", seasonNumber: 1 }];
		const srcEpsBySeason = new Map([
			[
				"s-src",
				[
					{ id: "ep-special", episodeType: "special", episodeNumber: 1 },
					{ id: "ep-regular", episodeType: "regular", episodeNumber: 1 },
				],
			],
		]);
		const tgtEpsBySeason = new Map([
			[
				"s-tgt",
				[
					{ id: "ep-tgt-special", episodeType: "special", episodeNumber: 1 },
					{ id: "ep-tgt-regular", episodeType: "regular", episodeNumber: 1 },
				],
			],
		]);

		const plan = planTvShowMerge(sourceSeasons, targetSeasons, srcEpsBySeason, tgtEpsBySeason);

		// Each source episode matches the target of the same type — no episode is
		// merged into the wrong special/regular twin.
		expect(plan.deleteEpisodeIds.toSorted()).toEqual(["ep-regular", "ep-special"]);
		expect(plan.movesByTargetSeason.size).toBe(0);
		expect(plan.mediaFileRepoints.get("ep-tgt-special")).toEqual(["ep-special"]);
		expect(plan.mediaFileRepoints.get("ep-tgt-regular")).toEqual(["ep-regular"]);
	});

	test("a special without a same-type target is moved, not merged into a regular", () => {
		const sourceSeasons = [{ id: "s-src", seasonNumber: 1 }];
		const targetSeasons = [{ id: "s-tgt", seasonNumber: 1 }];
		const srcEpsBySeason = new Map([["s-src", [{ id: "ep-special", episodeType: "special", episodeNumber: 1 }]]]);
		const tgtEpsBySeason = new Map([["s-tgt", [{ id: "ep-tgt-regular", episodeType: "regular", episodeNumber: 1 }]]]);

		const plan = planTvShowMerge(sourceSeasons, targetSeasons, srcEpsBySeason, tgtEpsBySeason);

		expect(plan.deleteEpisodeIds).toEqual([]);
		expect(plan.movesByTargetSeason.get("s-tgt")).toEqual(["ep-special"]);
		expect(plan.mediaFileRepoints.size).toBe(0);
	});
});
