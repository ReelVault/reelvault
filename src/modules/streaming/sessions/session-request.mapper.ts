import type { CreatePlaybackSession } from "@sdk/common/playback-sessions";
import { DEFAULT_BROWSER_CAPABILITIES } from "@sdk/common/stream.types";
import { unique } from "@/utils/array.utils";
import { ValidationError } from "@/utils/errors";
import { normalizeLower } from "@/utils/type.utils";
import { HDR_TRANSFER_ALLOWLIST } from "../decisions/codec-maps";
import type { PlaybackSessionInput } from "../streaming.types";

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Splits a comma-separated header/query list into canonical (lowercased, deduped, sorted) entries. */
function parseList(val?: string): string[] {
	if (!val) return [];

	return unique(
		val
			.split(",")
			.map((v) => normalizeLower(v))
			.filter(Boolean),
	).toSorted();
}

function normalize<T>(value: T | null | undefined): T | undefined {
	return value ?? undefined;
}

export function assertSafeId(id: string, label = "fileId"): void {
	if (!SAFE_ID_PATTERN.test(id)) {
		throw new ValidationError(`Invalid ${label}`);
	}
}

export function parseCapabilities(query: {
	videoCodecs?: string | undefined;
	audioCodecs?: string | undefined;
	maxBitrate?: number | undefined;
	hdrTransfers?: string | undefined;
}) {
	const videoCodecs = parseList(query.videoCodecs);
	const audioCodecs = parseList(query.audioCodecs);

	// Only known HDR transfers count — junk entries must not flip the passthrough gate.
	const hdrTransfers = parseList(query.hdrTransfers).filter((transfer) => HDR_TRANSFER_ALLOWLIST.has(transfer));

	return {
		videoCodecs: videoCodecs.length > 0 ? videoCodecs : DEFAULT_BROWSER_CAPABILITIES.videoCodecs,
		audioCodecs: audioCodecs.length > 0 ? audioCodecs : DEFAULT_BROWSER_CAPABILITIES.audioCodecs,
		hdrTransfers,
		maxBitrate: query.maxBitrate,
	};
}

export function toPlaybackSessionInput(body: CreatePlaybackSession): PlaybackSessionInput {
	return {
		videoCodecs: normalize(body.videoCodecs)?.join(","),
		audioCodecs: normalize(body.audioCodecs)?.join(","),
		maxBitrate: normalize(body.maxBitrate),
		hdrTransfers: normalize(body.hdrTransfers)?.join(","),
		audioStreamIndex: normalize(body.audioStreamIndex),
		audioLanguage: normalize(body.audioLanguage),
		subtitleLanguage: normalize(body.subtitleLanguage),
		subtitlesEnabled: normalize(body.subtitlesEnabled),
		forcedSubtitlesOnly: normalize(body.forcedSubtitlesOnly),
	};
}
