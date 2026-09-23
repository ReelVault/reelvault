import { describe, expect, test } from "bun:test";
import { rankImageOptions } from "./image-storage.utils";

const option = (overrides: Partial<{ url: string; score: number }> = {}) => ({
	providerId: "p1",
	providerName: "Provider",
	externalId: "1",
	type: "poster" as const,
	url: overrides.url ?? "https://img.example/1.jpg",
	...(overrides.score !== undefined ? { score: overrides.score } : {}),
});

describe("rankImageOptions", () => {
	test("sorts scored candidates best first", () => {
		const ranked = rankImageOptions([option({ score: 5, url: "a" }), option({ score: 9, url: "b" }), option({ score: 7, url: "c" })]);
		expect(ranked.map((item) => item.url)).toEqual(["b", "c", "a"]);
	});

	test("keeps provider order for unscored and equal candidates", () => {
		const ranked = rankImageOptions([option({ url: "a" }), option({ url: "b" }), option({ score: 1, url: "c" }), option({ url: "d" })]);
		expect(ranked.map((item) => item.url)).toEqual(["c", "a", "b", "d"]);

		const tied = rankImageOptions([option({ score: 4, url: "x" }), option({ score: 4, url: "y" })]);
		expect(tied.map((item) => item.url)).toEqual(["x", "y"]);
	});
});
