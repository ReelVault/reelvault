import { describe, expect, test } from "bun:test";
import { recognizeWithPluginHooks } from "../recognition/recognition";

describe("recognition plugin hooks", () => {
	test("normalizes the public recognition candidate before returning it to the scanner", () => {
		expect(
			recognizeWithPluginHooks("/library/Example Movie (2024)/Example Movie (2024).mkv", async (candidate) => ({
				...candidate,
				title: "Canonical title",
			})),
		).resolves.toMatchObject({
			type: "movie",
			identity: { title: "Canonical title", type: "movie", year: 2024 },
		});
	});

	test("rejects an invalid transformed candidate before metadata lookup", () => {
		expect(
			recognizeWithPluginHooks("/library/Example Movie (2024)/Example Movie (2024).mkv", async (candidate) => ({
				...candidate,
				title: "",
			})),
		).resolves.toBeNull();
	});
});
