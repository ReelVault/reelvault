import type { PlaybackViewResponse } from "@reelvault/sdk/common";

type EffectivePlaybackPreferences = PlaybackViewResponse["effectivePreferences"];
type SavedProgress = NonNullable<PlaybackViewResponse["progress"]>;

/**
 * First saved progress that fits the file being opened. A position saved against
 * a version with a different runtime can look like it is near the end, so an
 * incompatible candidate is dropped instead of being resumed.
 */
export function selectCompatibleProgress(
	candidates: ReadonlyArray<SavedProgress | null | undefined>,
	mediaFileDuration: number | null | undefined,
): SavedProgress | null {
	for (const candidate of candidates) {
		if (!candidate) continue;

		const savedDuration = candidate.duration;
		const openedDuration = mediaFileDuration ?? 0;
		if (savedDuration <= 0 || openedDuration <= 0 || Math.abs(savedDuration - openedDuration) <= 2) {
			return candidate;
		}
	}

	return null;
}

/** The lowest positive bitrate cap of the profile and the server (null when neither sets one), plus the HDR mode. */
export function resolveEffectivePlaybackPreferences(
	preferences:
		| { maxStreamingBitrateKbps?: number | undefined; hdrMode?: EffectivePlaybackPreferences["hdrMode"] | undefined }
		| null
		| undefined,
	serverPerStreamLimitKbps: number,
): EffectivePlaybackPreferences {
	const caps = [preferences?.maxStreamingBitrateKbps ?? 0, serverPerStreamLimitKbps].filter((cap) => cap > 0);

	return {
		maxStreamingBitrateKbps: caps.length > 0 ? Math.min(...caps) : null,
		hdrMode: preferences?.hdrMode ?? "auto",
	};
}
