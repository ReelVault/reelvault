import { describe, expect, test } from "bun:test";
import { resolveSessionSelection, type SessionSelectionInput } from "./session-selection.resolver";

function createInput(overrides: Partial<SessionSelectionInput> = {}): SessionSelectionInput {
	return {
		file: {
			duration: 1200,
			bitRate: 5_000_000,
			formatName: "matroska",
			videoStreams: [{ index: 0, isDefault: true, codecName: "h264", profile: "high", pixelFormat: "yuv420p", frameRate: "24000/1001" }],
			audioStreams: [
				{ index: 1, isDefault: true, language: "pol", codecName: "aac", channels: 2 },
				{ index: 2, isDefault: false, language: "eng", codecName: "aac", channels: 6 },
			],
			subtitles: [
				{ id: "sub-1", language: "pol", isDefault: true, isForced: false, streamIndex: 3, type: "embedded" },
				{ id: "sub-2", language: "eng", isDefault: false, isForced: false, streamIndex: 4, type: "embedded" },
			],
		},
		preferences: { audioLanguage: null, subtitleLanguage: null, subtitlesEnabled: true, forcedSubtitlesOnly: false },
		capabilitiesQuery: {},
		capabilities: { videoCodecs: ["h264"], audioCodecs: ["aac"] },
		smartSelectionEnabled: false,
		...overrides,
	};
}

describe("session selection resolver", () => {
	test("without any language preference no subtitle is auto-selected", () => {
		const selection = resolveSessionSelection(createInput());

		expect(selection.videoCodec).toBe("h264");
		expect(selection.audioStream?.index).toBe(1);
		expect(selection.subtitle).toBeUndefined();
		expect(selection.playbackPreferences.subtitlesEnabled).toBe(true);
		expect(typeof selection.decision.mode).toBe("string");
	});

	test("audio matching the preferred language suppresses full subtitles and picks forced ones", () => {
		const selection = resolveSessionSelection(
			createInput({
				preferences: { audioLanguage: "pol", subtitleLanguage: "pol", subtitlesEnabled: true, forcedSubtitlesOnly: false },
			}),
		);

		expect(selection.subtitle).toBeUndefined();

		const withForced = createInput({
			preferences: { audioLanguage: "pol", subtitleLanguage: "pol", subtitlesEnabled: true, forcedSubtitlesOnly: false },
		});
		withForced.file.subtitles = [
			{ id: "sub-forced", language: "pol", isDefault: false, isForced: true, streamIndex: 5, type: "embedded" },
			...withForced.file.subtitles,
		];

		expect(resolveSessionSelection(withForced).subtitle?.id).toBe("sub-forced");
	});

	test("audio differing from the preferred language selects that language's subtitles", () => {
		const selection = resolveSessionSelection(
			createInput({
				preferences: { audioLanguage: "eng", subtitleLanguage: "pol", subtitlesEnabled: true, forcedSubtitlesOnly: false },
				capabilitiesQuery: { audioStreamIndex: 2 },
			}),
		);

		expect(selection.audioStream?.index).toBe(2);
		expect(selection.subtitle?.id).toBe("sub-1");
	});

	test("per-title languages override profile preferences", () => {
		const selection = resolveSessionSelection(
			createInput({
				preferences: { audioLanguage: null, subtitleLanguage: null, subtitlesEnabled: true, forcedSubtitlesOnly: false },
				perTitlePreferences: { subtitleLanguage: "eng" },
			}),
		);

		// Polish audio stays, but the per-title subtitle language (eng) differs from
		// the audio language, so the English subtitle is selected.
		expect(selection.audioStream?.index).toBe(1);
		expect(selection.subtitle?.id).toBe("sub-2");
	});

	test("a saved per-title null turns subtitles off despite the global default", () => {
		const selection = resolveSessionSelection(createInput({ savedSubtitleId: null, hasActiveProgress: true }));

		expect(selection.subtitle).toBeUndefined();
		expect(selection.playbackPreferences.subtitlesEnabled).toBe(false);
	});

	test("a saved per-title subtitle id pins that subtitle", () => {
		const selection = resolveSessionSelection(createInput({ savedSubtitleId: "sub-2", hasActiveProgress: true }));

		expect(selection.subtitle?.id).toBe("sub-2");
		expect(selection.playbackPreferences.subtitlesEnabled).toBe(true);
	});

	test("a saved per-title choice is ignored without active progress", () => {
		const selection = resolveSessionSelection(
			createInput({
				savedSubtitleId: null,
				preferences: { audioLanguage: null, subtitleLanguage: "eng", subtitlesEnabled: true, forcedSubtitlesOnly: false },
			}),
		);

		// The stale pin no longer applies — the preference decides instead.
		expect(selection.subtitle?.id).toBe("sub-2");
		expect(selection.playbackPreferences.subtitlesEnabled).toBe(true);
	});

	test("an active title reopens on its remembered audio track", () => {
		const selection = resolveSessionSelection(
			createInput({
				savedAudioStreamIndex: 2,
				hasActiveProgress: true,
				preferences: { audioLanguage: "pol", subtitleLanguage: null, subtitlesEnabled: true, forcedSubtitlesOnly: false },
			}),
		);

		expect(selection.audioStream?.index).toBe(2);
	});

	test("remembered audio track is ignored without active progress", () => {
		const selection = resolveSessionSelection(
			createInput({
				savedAudioStreamIndex: 2,
				preferences: { audioLanguage: "pol", subtitleLanguage: null, subtitlesEnabled: true, forcedSubtitlesOnly: false },
			}),
		);

		expect(selection.audioStream?.index).toBe(1);
	});

	test("explicit request index beats the remembered audio track", () => {
		const selection = resolveSessionSelection(
			createInput({
				savedAudioStreamIndex: 1,
				hasActiveProgress: true,
				capabilitiesQuery: { audioStreamIndex: 2 },
			}),
		);

		expect(selection.audioStream?.index).toBe(2);
	});

	test("an unknown saved subtitle id falls back to the preference-based selection", () => {
		const selection = resolveSessionSelection(
			createInput({
				savedSubtitleId: "sub-gone",
				hasActiveProgress: true,
				preferences: { audioLanguage: null, subtitleLanguage: "eng", subtitlesEnabled: true, forcedSubtitlesOnly: false },
			}),
		);

		expect(selection.subtitle?.id).toBe("sub-2");
		expect(selection.playbackPreferences.subtitlesEnabled).toBe(true);
	});

	test("explicit audio stream index overrides the language preference", () => {
		const selection = resolveSessionSelection(
			createInput({
				capabilitiesQuery: { audioStreamIndex: 2 },
				preferences: { audioLanguage: "pol", subtitleLanguage: null, subtitlesEnabled: true, forcedSubtitlesOnly: false },
			}),
		);

		expect(selection.audioStream?.index).toBe(2);
		// Without a subtitle language preference the smart selection stays empty
		// even though the English track was chosen explicitly.
		expect(selection.subtitle).toBeUndefined();
	});

	test("audio language preference drives stream selection when smart selection is on", () => {
		const selection = resolveSessionSelection(
			createInput({
				preferences: { audioLanguage: "eng", subtitleLanguage: null, subtitlesEnabled: true, forcedSubtitlesOnly: false },
				smartSelectionEnabled: true,
			}),
		);

		expect(selection.audioStream?.language).toBe("eng");
	});

	test("disabled subtitles yield no subtitle", () => {
		const selection = resolveSessionSelection(
			createInput({
				preferences: { audioLanguage: null, subtitleLanguage: null, subtitlesEnabled: false, forcedSubtitlesOnly: false },
			}),
		);

		expect(selection.subtitle).toBeUndefined();
	});

	test("falls back to the first stream when none is default", () => {
		const input = createInput();
		input.file = {
			...input.file,
			videoStreams: [{ index: 5, isDefault: false, codecName: "hevc", profile: null, pixelFormat: null, frameRate: null }],
		};

		const selection = resolveSessionSelection(input);

		expect(selection.videoCodec).toBe("hevc");
	});
});
