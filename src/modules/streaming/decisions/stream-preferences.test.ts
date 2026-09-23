import { describe, expect, test } from "bun:test";
import type { Subtitle } from "../streaming.types";
import { resolvePlaybackPreferences, selectPreferredAudioStream, selectPreferredSubtitle } from "./stream-preferences";

const streams = [
	{ index: 0, codecName: "aac", language: "en", isDefault: true },
	{ index: 1, codecName: "ac3", language: "pl", isDefault: false },
	{ index: 2, codecName: "aac", language: null, isDefault: false },
];

const subtitle = (id: string, language: string, overrides: Partial<Subtitle> = {}): Subtitle => ({
	id,
	language,
	isDefault: false,
	isForced: false,
	streamIndex: null,
	type: "embedded",
	...overrides,
});

const plFull = subtitle("pl", "pl");
const plForced = subtitle("pl-forced", "pl", { isForced: true });
const plSdh = subtitle("pl-sdh", "pl", { isHearingImpaired: true });
const enFull = subtitle("en", "en", { isDefault: true });

describe("stream preferences", () => {
	test("prefers explicit stream override over language preference", () => {
		expect(selectPreferredAudioStream(streams, "en", 1)?.index).toBe(1);
	});

	test("explicit override may still select a commentary track", () => {
		const withCommentary = [
			{ index: 0, codecName: "aac", language: "en", isDefault: true, isCommentary: false },
			{ index: 1, codecName: "aac", language: "en", isDefault: false, isCommentary: true },
		];

		expect(selectPreferredAudioStream(withCommentary, "en", 1)?.index).toBe(1);
	});

	test("selects a case-insensitive preferred language and falls back to default", () => {
		expect(selectPreferredAudioStream(streams, "PL")?.index).toBe(1);
		expect(selectPreferredAudioStream(streams, "de")?.index).toBe(0);
	});

	test("matches ISO 639-2 stream tags against ISO 639-1 preferences", () => {
		const mkvStreams = [
			{ index: 0, codecName: "eac3", language: "pol", isDefault: true },
			{ index: 1, codecName: "eac3", language: "eng", isDefault: false },
		];

		expect(selectPreferredAudioStream(mkvStreams, "en")?.index).toBe(1);
		expect(selectPreferredAudioStream(mkvStreams, "pl")?.index).toBe(0);
		expect(selectPreferredAudioStream(mkvStreams, "EN")?.index).toBe(1);
	});

	test("subtitles match ISO 639-2 tags with ISO 639-1 preferences", () => {
		const subtitles = [subtitle("sub-pl-forced", "pol", { isForced: true }), subtitle("sub-eng", "eng", { isDefault: true })];

		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: "eng",
				subtitleLanguage: "en",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: false,
				autoForcedSubtitles: true,
				preferHearingImpaired: false,
			}),
		).toBeUndefined();
		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: "pol",
				subtitleLanguage: "pl",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: true,
				autoForcedSubtitles: true,
				preferHearingImpaired: false,
			})?.id,
		).toBe("sub-pl-forced");
	});

	test("skips commentary tracks in language and default selection", () => {
		const withCommentary = [
			{ index: 0, codecName: "aac", language: "en", isDefault: true, isCommentary: true },
			{ index: 1, codecName: "aac", language: "pl", isDefault: false, isCommentary: false },
			{ index: 2, codecName: "aac", language: "de", isDefault: false, isCommentary: false },
		];

		expect(selectPreferredAudioStream(withCommentary, "en")?.index).toBe(1);
		expect(selectPreferredAudioStream(withCommentary, "de")?.index).toBe(2);
	});

	test("falls back to a commentary track only when every stream is commentary", () => {
		const onlyCommentary = [{ index: 0, codecName: "aac", language: "en", isDefault: true, isCommentary: true }];

		expect(selectPreferredAudioStream(onlyCommentary, "en")?.index).toBe(0);
	});

	test("resolves session overrides first, profile preferences second, per-title languages last", () => {
		const profile = {
			audioLanguage: "en",
			subtitleLanguage: "en",
			subtitlesEnabled: true,
			forcedSubtitlesOnly: false,
			autoForcedSubtitles: true,
		};

		expect(
			resolvePlaybackPreferences(
				profile,
				{ audioLanguage: "pl", subtitlesEnabled: false },
				{ audioLanguage: "de", subtitleLanguage: "fr" },
			),
		).toEqual({
			audioLanguage: "pl",
			subtitleLanguage: "en",
			subtitlesEnabled: false,
			forcedSubtitlesOnly: false,
			autoForcedSubtitles: true,
			preferHearingImpaired: false,
		});
		expect(resolvePlaybackPreferences(profile, {}, { subtitleLanguage: "fr" }).subtitleLanguage).toBe("en");
		expect(
			resolvePlaybackPreferences(
				{ audioLanguage: null, subtitleLanguage: null, subtitlesEnabled: true, forcedSubtitlesOnly: false },
				{},
				{
					subtitleLanguage: "pl",
				},
			).subtitleLanguage,
		).toBe("pl");
	});

	test("per-title null languages do not clear profile preferences", () => {
		expect(
			resolvePlaybackPreferences(
				{ audioLanguage: "en", subtitleLanguage: "pl", subtitlesEnabled: true, forcedSubtitlesOnly: false },
				{},
				{ audioLanguage: null, subtitleLanguage: null },
			),
		).toMatchObject({ audioLanguage: "en", subtitleLanguage: "pl" });
	});

	test("defaults autoForcedSubtitles to enabled and preferHearingImpaired to disabled", () => {
		expect(resolvePlaybackPreferences(null, {})).toMatchObject({ autoForcedSubtitles: true, preferHearingImpaired: false });
	});

	test("audio matching the preferred language suppresses full subtitles", () => {
		const subtitles = [enFull, plFull];

		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: "pl",
				subtitleLanguage: "pl",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: false,
				autoForcedSubtitles: false,
				preferHearingImpaired: false,
			}),
		).toBeUndefined();
	});

	test("audio matching the preferred language picks forced subtitles in that language", () => {
		const subtitles = [enFull, plFull, plForced];

		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: "pl",
				subtitleLanguage: "pl",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: false,
				autoForcedSubtitles: true,
				preferHearingImpaired: false,
			})?.id,
		).toBe("pl-forced");
	});

	test("subtitle language falls back to the preferred audio language", () => {
		const subtitles = [enFull, plForced];

		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: "pl",
				subtitleLanguage: null,
				subtitlesEnabled: true,
				forcedSubtitlesOnly: false,
				autoForcedSubtitles: true,
				preferHearingImpaired: false,
			})?.id,
		).toBe("pl-forced");
	});

	test("audio differing from the preferred language picks full subtitles over forced ones", () => {
		const subtitles = [enFull, plForced, plFull];

		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: "en",
				subtitleLanguage: "pl",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: false,
				autoForcedSubtitles: true,
				preferHearingImpaired: false,
			})?.id,
		).toBe("pl");
	});

	test("forced-only mode picks a forced subtitle when no full one exists", () => {
		const subtitles = [enFull, plForced];

		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: "en",
				subtitleLanguage: "pl",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: true,
				autoForcedSubtitles: false,
				preferHearingImpaired: false,
			})?.id,
		).toBe("pl-forced");
		expect(
			selectPreferredSubtitle([enFull, plFull], {
				audioLanguage: "en",
				subtitleLanguage: "pl",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: true,
				autoForcedSubtitles: false,
				preferHearingImpaired: false,
			}),
		).toBeUndefined();
	});

	test("no subtitle in the preferred language means none are selected", () => {
		const subtitles = [enFull];

		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: "de",
				subtitleLanguage: "pl",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: false,
				autoForcedSubtitles: true,
				preferHearingImpaired: false,
			}),
		).toBeUndefined();
	});

	test("master switch disables all automatic selection including forced", () => {
		const subtitles = [enFull, plForced];

		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: "pl",
				subtitleLanguage: "pl",
				subtitlesEnabled: false,
				forcedSubtitlesOnly: false,
				autoForcedSubtitles: true,
				preferHearingImpaired: false,
			}),
		).toBeUndefined();
	});

	test("hearing-impaired preference picks the SDH variant in the preferred language", () => {
		const subtitles = [plFull, plSdh];

		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: "en",
				subtitleLanguage: "pl",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: false,
				autoForcedSubtitles: false,
				preferHearingImpaired: true,
			})?.id,
		).toBe("pl-sdh");
		expect(
			selectPreferredSubtitle([plFull, plSdh], {
				audioLanguage: "en",
				subtitleLanguage: "pl",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: false,
				autoForcedSubtitles: false,
				preferHearingImpaired: false,
			})?.id,
		).toBe("pl");
	});

	test("unknown audio language still selects preferred-language subtitles", () => {
		const subtitles = [enFull, plFull];

		expect(
			selectPreferredSubtitle(subtitles, {
				audioLanguage: null,
				subtitleLanguage: "pl",
				subtitlesEnabled: true,
				forcedSubtitlesOnly: false,
				autoForcedSubtitles: false,
				preferHearingImpaired: false,
			})?.id,
		).toBe("pl");
	});
});
