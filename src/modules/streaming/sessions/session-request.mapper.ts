import type { CreatePlaybackSession } from "@reelvault/sdk/common";
import { DEFAULT_BROWSER_CAPABILITIES } from "@reelvault/sdk/common";
import { HDR_TRANSFER_ALLOWLIST } from "@/modules/streaming/decisions/codec-maps.constants";
import type { PlaybackSessionInput } from "@/modules/streaming/streaming.types";
import { normalizeStringList } from "@/modules/streaming/utils/string-list.utils";
import { DomainError } from "@/utils/domain.errors";

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Splits a comma-separated header/query list into canonical (lowercased, deduped, sorted) entries. */
function parseList(val?: string): string[] {
	if (!val) return [];

	return normalizeStringList(val.split(","));
}

export function assertSafeId(id: string, label = "fileId"): void {
	if (!SAFE_ID_PATTERN.test(id)) {
		throw new DomainError("validation", `Invalid ${label}`, { code: "stream.id_invalid" });
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
		videoCodecs: body.videoCodecs?.join(","),
		audioCodecs: body.audioCodecs?.join(","),
		maxBitrate: body.maxBitrate ?? undefined,
		hdrTransfers: body.hdrTransfers?.join(","),
		audioStreamIndex: body.audioStreamIndex ?? undefined,
		audioLanguage: body.audioLanguage ?? undefined,
		subtitleLanguage: body.subtitleLanguage ?? undefined,
		subtitlesEnabled: body.subtitlesEnabled ?? undefined,
		forcedSubtitlesOnly: body.forcedSubtitlesOnly ?? undefined,
	};
}
