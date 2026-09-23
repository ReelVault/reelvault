import { describe, expect, test } from "bun:test";
import { resolveSubtitleType, toPublicSubtitle } from "./subtitle.mapper";

describe("resolveSubtitleType", () => {
	test("infers external from sourcePath and embedded from streamIndex", () => {
		expect(resolveSubtitleType({ sourcePath: "/subs/movie.srt" })).toBe("external");
		expect(resolveSubtitleType({ streamIndex: 3 })).toBe("embedded");
	});

	test("accepts an explicit type that matches the source", () => {
		expect(resolveSubtitleType({ sourcePath: "/subs/movie.srt", type: "external" })).toBe("external");
		expect(resolveSubtitleType({ streamIndex: 3, type: "embedded" })).toBe("embedded");
	});

	test("rejects neither, both, and a type that contradicts the source", () => {
		expect(() => resolveSubtitleType({})).toThrow("exactly one");
		expect(() => resolveSubtitleType({ sourcePath: "/a.srt", streamIndex: 2 })).toThrow("exactly one");
		expect(() => resolveSubtitleType({ streamIndex: 2, type: "external" })).toThrow("does not match");
	});
});

describe("toPublicSubtitle", () => {
	test("maps a row to the public contract with ISO timestamps", () => {
		expect(
			toPublicSubtitle({
				id: "sub-1",
				mediaFileId: "file-1",
				language: "pl",
				label: "Polski",
				format: "vtt",
				type: "external",
				streamIndex: null,
				isDefault: true,
				isForced: false,
				isHearingImpaired: false,
				createdAt: new Date("2026-08-01T10:00:00.000Z"),
				updatedAt: new Date("2026-08-01T11:00:00.000Z"),
			}),
		).toEqual({
			id: "sub-1",
			mediaFileId: "file-1",
			language: "pl",
			label: "Polski",
			format: "vtt",
			type: "external",
			streamIndex: null,
			isDefault: true,
			isForced: false,
			isHearingImpaired: false,
			createdAt: "2026-08-01T10:00:00.000Z",
			updatedAt: "2026-08-01T11:00:00.000Z",
		});
	});

	test("passes through ISO strings and normalizes unknown types to external", () => {
		const mapped = toPublicSubtitle({
			id: "sub-2",
			mediaFileId: "file-1",
			language: "en",
			label: null,
			format: "srt",
			type: "weird-value",
			streamIndex: 2,
			isDefault: false,
			isForced: true,
			isHearingImpaired: true,
			createdAt: "2026-08-01T10:00:00.000Z",
			updatedAt: "2026-08-01T10:00:00.000Z",
		});

		expect(mapped.type).toBe("external");
		expect(mapped.createdAt).toBe("2026-08-01T10:00:00.000Z");
	});
});
