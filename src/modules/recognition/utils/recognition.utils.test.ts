import { describe, expect, test } from "bun:test";
import type { MediaIdentity } from "@sdk/common/media";
import { resolveShowTitle } from "./recognition.utils";

function identity(title: string, year?: number): MediaIdentity {
	return { title, type: "movie", year };
}

describe("resolveShowTitle", () => {
	test("keeps the show folder title and its year", () => {
		expect(resolveShowTitle(identity("Friends", 1994), null)).toEqual({ title: "Friends", year: 1994 });
	});

	test("falls back to the file year when the show folder has none", () => {
		expect(resolveShowTitle(identity("Friends"), identity("Friends S01E01", 1994)).year).toBe(1994);
	});

	test("adopting the file title rescues a show folder named only by its year", () => {
		const result = resolveShowTitle(identity("2012"), identity("Elementary", 2012));
		expect(result.title).toBe("Elementary");
		expect(result.year).toBe(2012);
	});

	test("keeps the year-named show title when the file title is also just a year", () => {
		expect(resolveShowTitle(identity("2012"), identity("2013", 2012)).title).toBe("2012");
	});

	test("prefers the longer file title when it extends the show title", () => {
		expect(resolveShowTitle(identity("the office"), identity("The Office US")).title).toBe("The Office US");
	});

	test("keeps the show title when the file title is longer but unrelated", () => {
		expect(resolveShowTitle(identity("Friends"), identity("Some Other Show"))).toEqual({
			title: "Friends",
			year: undefined,
		});
	});
});
