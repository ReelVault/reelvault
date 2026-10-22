import { describe, expect, test } from "bun:test";
import { isTextExtractable, resolveSubtitleType, toPublicSubtitle } from "./subtitle.mapper";

const embeddedRow = {
	id: "sub-1",
	mediaFileId: "file-1",
	language: "en",
	label: null,
	streamIndex: 2,
	isDefault: false,
	isForced: false,
	isHearingImpaired: false,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

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
		expect(() => resolveSubtitleType({})).toThrow(expect.objectContaining({ category: "validation", code: "subtitle.source_invalid" }));
		expect(() => resolveSubtitleType({ sourcePath: "/a.srt", streamIndex: 2 })).toThrow(
			expect.objectContaining({ category: "validation", code: "subtitle.source_invalid" }),
		);
		expect(() => resolveSubtitleType({ streamIndex: 2, type: "external" })).toThrow(
			expect.objectContaining({ category: "validation", code: "subtitle.type_mismatch" }),
		);
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
			extractable: true,
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

describe("subtitle extractability", () => {
	test("image-based embedded tracks are not extractable as text", () => {
		expect(isTextExtractable({ type: "embedded", format: "hdmv_pgs_subtitle" })).toBe(false);
		expect(isTextExtractable({ type: "embedded", format: "dvd_subtitle" })).toBe(false);
		expect(isTextExtractable({ type: "embedded", format: "subrip" })).toBe(true);
	});

	test("the public subtitle carries the extractable flag", () => {
		expect(toPublicSubtitle({ ...embeddedRow, type: "embedded", format: "pgssub" })).toMatchObject({ extractable: false });
		expect(toPublicSubtitle({ ...embeddedRow, type: "embedded", format: "subrip" })).toMatchObject({ extractable: true });
	});
});
