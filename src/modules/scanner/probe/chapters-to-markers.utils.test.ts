import { describe, expect, test } from "bun:test";
import type { FFProbeChapter } from "@/integrations/ffprobe/ffprobe.types";
import { type MarkerKeywords, mapChaptersToMarkers } from "./chapters-to-markers.utils";

const chapter = (startTime: string, endTime: string, title?: string): FFProbeChapter => ({
	start_time: startTime,
	end_time: endTime,
	...(title !== undefined ? { tags: { title } } : {}),
});

const ENGLISH_KEYWORDS: MarkerKeywords = {
	intro: ["intro", "opening", "op"],
	credits: ["credits", "credit", "ending", "outro"],
	recap: ["recap", "previously"],
};

describe("mapChaptersToMarkers (default English keywords)", () => {
	test("classifies intro, credits and recap chapters", () => {
		const markers = mapChaptersToMarkers(
			[
				chapter("00:00:00.000", "00:01:30.000", "Intro"),
				chapter("00:20:00.000", "00:20:20.000", "Recap of previous episode"),
				chapter("00:41:00.000", "00:43:10.000", "Ending"),
			],
			ENGLISH_KEYWORDS,
		);

		expect(markers.map((marker) => marker.type)).toEqual(["intro", "recap", "credits"]);
		expect(markers[0]).toMatchObject({ startSeconds: 0, endSeconds: 90, label: "Intro" });
	});

	test("is case and diacritic tolerant on both sides", () => {
		const markers = mapChaptersToMarkers([chapter("00:00:00.000", "00:01:00.000", "Opening")], {
			intro: ["Opénïng"],
			credits: [],
			recap: [],
		});
		expect(markers[0]?.type).toBe("intro");
	});

	test("skips untitled, too short and absurdly long chapters", () => {
		const markers = mapChaptersToMarkers(
			[
				chapter("00:00:00.000", "00:01:00.000"),
				chapter("00:01:00.000", "00:01:03.000", "Intro"),
				chapter("00:02:00.000", "00:40:00.000", "Credits"),
				chapter("00:41:00.000", "00:42:00.000", "Random chapter mentioning intro inside"),
			],
			ENGLISH_KEYWORDS,
		);

		expect(markers).toHaveLength(0);
	});
});

describe("mapChaptersToMarkers (configured keywords)", () => {
	test("keyword lists are fully configurable — any language works", () => {
		const arabic: MarkerKeywords = { intro: ["مقدمة"], credits: ["نهاية"], recap: [] };

		const markers = mapChaptersToMarkers(
			[chapter("00:00:05.000", "00:01:20.000", "مقدمة"), chapter("00:20:00.000", "00:21:30.000", "نهاية")],
			arabic,
		);

		expect(markers.map((marker) => marker.type)).toEqual(["intro", "credits"]);
	});
});
