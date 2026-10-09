import { describe, expect, it } from "bun:test";
import { detectUploadedSubtitleFormat } from "./subtitle-upload.utils";

describe("detectUploadedSubtitleFormat", () => {
	it("accepts SRT with a timing line", () => {
		expect(detectUploadedSubtitleFormat("movie.srt", "1\n00:00:01,000 --> 00:00:02,000\nHello\n")).toBe("srt");
	});

	it("accepts WebVTT with the WEBVTT header", () => {
		expect(detectUploadedSubtitleFormat("movie.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n")).toBe("vtt");
	});

	it("accepts ASS with an [Events] section", () => {
		expect(detectUploadedSubtitleFormat("movie.ass", "[Script Info]\nTitle: x\n[Events]\nFormat: Layer\n")).toBe("ass");
	});

	it("refuses a renamed file whose text is not the format its extension claims", () => {
		expect(detectUploadedSubtitleFormat("movie.srt", "WEBVTT\n")).toBeNull();
		expect(detectUploadedSubtitleFormat("movie.vtt", "1\n00:00:01,000 --> 00:00:02,000\n")).toBeNull();
	});

	it("refuses other extensions, including SSA and files without one", () => {
		expect(detectUploadedSubtitleFormat("movie.ssa", "[Events]\n")).toBeNull();
		expect(detectUploadedSubtitleFormat("movie", "WEBVTT")).toBeNull();
	});
});
