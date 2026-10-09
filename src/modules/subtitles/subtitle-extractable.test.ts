import { describe, expect, test } from "bun:test";
import { isTextExtractable, toPublicSubtitle } from "./subtitle.mapper";
import { subtitleContentResolver } from "./subtitle-content.resolver";

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

	test("asking for an image-based track names its code instead of reporting it missing", async () => {
		await expect(
			subtitleContentResolver.resolve("sub-1", {
				type: "embedded",
				mediaFileId: "file-1",
				streamIndex: 2,
				format: "hdmv_pgs_subtitle",
				mediaFilePath: "/media/file.mkv",
			}),
		).rejects.toMatchObject({ code: "subtitle.bitmap_unsupported" });
	});
});
