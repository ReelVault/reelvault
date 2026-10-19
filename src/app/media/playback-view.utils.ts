import type { PlaybackViewResponse } from "@reelvault/sdk/common";

type EffectivePlaybackPreferences = PlaybackViewResponse["effectivePreferences"];

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
