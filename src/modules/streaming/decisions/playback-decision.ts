import type { ClientCapabilities, PlaybackDecision, PlaybackReasonPart } from "@reelvault/sdk/common";
import { serverConfig } from "@/server.config";
import type { MediaFileInfo } from "../streaming.types";
import { AUDIO_CODEC_MAP, HDR_TRANSFER_ALLOWLIST, normalizeCodec, VIDEO_CODEC_MAP } from "./codec-maps";

const TEN_BIT_PIXEL_FORMAT_REGEX = /(?:10)(?:le|be)$|p010/i;
const TWELVE_BIT_PIXEL_FORMAT_REGEX = /(?:12)(?:le|be)$|p016/i;
const HIGH_TEN_H264_PROFILE_REGEX = /high\s*10/i;

/**
 * Determines whether streams need re-encoding. Output is always fMP4 HLS —
 * the only question is `-c copy` vs re-encode.
 *
 * direct-stream → both streams compatible & within bandwidth limit → -c:v copy -c:a copy (fast, lossless)
 * transcode     → one or both incompatible / bandwidth capped      → libx264 (or HW) / aac (CPU/GPU)
 */
function buildCodecSet(codecs: readonly string[]): Set<string> {
	return new Set(codecs.map((codec) => codec.toLowerCase()));
}

function resolveHdrLabel(doviProfile: number | null | undefined, hdrTransfer: string | null): string {
	if (doviProfile != null) return `DV${doviProfile}`;

	return hdrTransfer === "arib-std-b67" ? "HLG" : "HDR10";
}

function resolvePassthroughTransfer(doviProfile: number | null | undefined, hdrTransfer: string | null): string | null {
	if (doviProfile == null) return hdrTransfer;

	return doviProfile === 8 ? "smpte2084" : null;
}

interface VideoVerdict {
	videoOk: boolean;
	isHdr: boolean;
	hdrTransfer: string | null;
	hdrLabel: string;
	hdrPassthrough: boolean;
	isHighTenH264: boolean;
	isTwelveBit: boolean;
	bitDepthUnsupported: boolean;
}

// Bit-depth gates. MSE capability probing is name-only ("h265") and 10-bit
// support is NOT implied by it: HEVC Main10 / VP9 profile 2 require a separate
// client probe ("<codec>-10bit"). AV1 is the exception — 10-bit belongs to its
// main profile (0), so every AV1-capable client decodes it. 12-bit has no
// browser MSE path at all.
//
// Browsers cannot render PQ/HLG inside an fMP4 HLS pipeline and DV RPU is
// lost on remux — HDR content transcodes and needs tone-mapping to SDR,
// UNLESS the client declares a render path for the source's transfer (see
// hdrPassthrough below), regardless of the h265-10bit capability.
//
// HDR passthrough — a client that probes as able to render the source's
// transfer gets the original stream remuxed untouched. DV profile 8
// qualifies through its HDR10-compatible base layer (smpte2084); profile 5's
// IPTPQc2 base is unviewable once remux strips the RPU, so it always
// transcodes no matter what the client reports.
function judgeVideo(file: MediaFileInfo, videoCodec: string | null, capabilities: ClientCapabilities): VideoVerdict {
	const videoCodecSet = buildCodecSet(capabilities.videoCodecs);
	const pixelFormat = file.videoPixelFormat ?? "";
	const isTwelveBit = TWELVE_BIT_PIXEL_FORMAT_REGEX.test(pixelFormat);
	const isTenBit = TEN_BIT_PIXEL_FORMAT_REGEX.test(pixelFormat);
	const reportsTenBit = videoCodec === "av1" || (videoCodec !== null && videoCodecSet.has(`${videoCodec}-10bit`));
	const bitDepthUnsupported = isTwelveBit || (isTenBit && !reportsTenBit);
	const isHighTenH264 = videoCodec === "h264" && HIGH_TEN_H264_PROFILE_REGEX.test(file.videoProfile ?? "");
	const lowerTransfer = file.videoColorTransfer?.toLowerCase();
	const hdrTransfer = lowerTransfer && HDR_TRANSFER_ALLOWLIST.has(lowerTransfer) ? lowerTransfer : null;
	const isHdr = hdrTransfer !== null || file.doviProfile != null;
	const hdrLabel = resolveHdrLabel(file.doviProfile, hdrTransfer);
	const clientHdrTransfers = new Set(capabilities.hdrTransfers ?? []);
	const passthroughTransfer = resolvePassthroughTransfer(file.doviProfile, hdrTransfer);
	const hdrPassthrough = isHdr && passthroughTransfer !== null && clientHdrTransfers.has(passthroughTransfer);
	const videoOk = (!videoCodec || videoCodecSet.has(videoCodec)) && !bitDepthUnsupported && !isHighTenH264 && (!isHdr || hdrPassthrough);

	return { videoOk, isHdr, hdrTransfer, hdrLabel, hdrPassthrough, isHighTenH264, isTwelveBit, bitDepthUnsupported };
}

function bitDepthSuffix(video: VideoVerdict): " High10" | " 12-bit" | " 10-bit" | "" {
	if (video.isHighTenH264) return " High10";

	if (video.isTwelveBit) return " 12-bit";

	if (video.bitDepthUnsupported) return " 10-bit";

	return "";
}

function bitrateSuffix(videoBitrateKbps: number | undefined, bandwidthCappedReason: string | null): string {
	if (!videoBitrateKbps) return "";

	const capNote = bandwidthCappedReason ? ` [${bandwidthCappedReason}]` : "";

	return ` (${videoBitrateKbps}kbps${capNote})`;
}

function videoTranscodeReason(
	video: VideoVerdict,
	displayVideoCodec: string,
	depth: string,
	bitrate: string,
	toneMapAvailable: boolean,
): string {
	if (!video.isHdr) return `video:${displayVideoCodec}${depth} → H.264${bitrate}`;

	const toneMapNote = toneMapAvailable ? "tone-mapped to SDR" : "no tone-mapping available";

	return `video:${displayVideoCodec} ${video.hdrLabel}${depth} → H.264${bitrate}, ${toneMapNote}`;
}

interface VideoReasonInput {
	video: VideoVerdict;
	videoTranscode: boolean;
	videoCodec: string | null;
	depth: string;
	videoBitrateKbps: number | undefined;
	toneMapAvailable: boolean;
}

function videoReasonPart({
	video,
	videoTranscode,
	videoCodec,
	depth,
	videoBitrateKbps,
	toneMapAvailable,
}: VideoReasonInput): PlaybackReasonPart {
	if (!videoTranscode) return { code: "video.copy", params: { codec: videoCodec } };

	if (video.isHdr) {
		return {
			code: "video.transcode_hdr",
			params: { codec: videoCodec, hdr: video.hdrLabel, bitrateKbps: videoBitrateKbps ?? null, toneMapped: toneMapAvailable },
		};
	}

	return { code: "video.transcode", params: { codec: videoCodec, bitDepth: depth.trim() || null, bitrateKbps: videoBitrateKbps ?? null } };
}

interface BitratePlan {
	effectiveBitrateKbps: number | undefined;
	bandwidthCappedReason: string | null;
}

function planBitrate(
	clientRequestedBitrate: number | undefined,
	sourceBitrateKbps: number | undefined,
	serverPerStreamLimit: number,
): BitratePlan {
	const plan: BitratePlan = { effectiveBitrateKbps: undefined, bandwidthCappedReason: null };
	if (clientRequestedBitrate) {
		plan.effectiveBitrateKbps = serverPerStreamLimit > 0 ? Math.min(clientRequestedBitrate, serverPerStreamLimit) : clientRequestedBitrate;
		// The cap only matters when the source exceeds it — a 4 Mbps file under a
		// 5 Mbps limit remuxes untouched instead of re-encoding. `bitRate` is the
		// whole-container rate, so staying under it guarantees the video stream is.
		if (sourceBitrateKbps !== undefined && sourceBitrateKbps <= plan.effectiveBitrateKbps) {
			plan.effectiveBitrateKbps = undefined;
		}
	} else if (serverPerStreamLimit > 0 && sourceBitrateKbps && sourceBitrateKbps > serverPerStreamLimit) {
		plan.effectiveBitrateKbps = serverPerStreamLimit;
		plan.bandwidthCappedReason = `source bitrate (${sourceBitrateKbps}kbps) exceeds server bandwidth limit (${serverPerStreamLimit}kbps)`;
	}

	return plan;
}

export interface PlaybackDecisionOptions {
	/** False when no HDR→SDR tone-mapping filter is usable, so an HDR transcode cannot tone-map. */
	toneMapAvailable?: boolean;
}

interface PlanInput {
	file: MediaFileInfo;
	audioStreamIndex: number | undefined;
	videoCodec: string | null;
	audioCodec: string | null;
	video: VideoVerdict;
}

interface TranscodeInput extends PlanInput {
	audioTranscode: boolean;
	videoBitrateKbps: number | undefined;
	bandwidthCappedReason: string | null;
	toneMapAvailable: boolean;
}

function directStreamDecision({ file, audioStreamIndex, videoCodec, audioCodec, video }: PlanInput): PlaybackDecision {
	const displayVideoCodec = videoCodec ?? "?";
	const displayAudioCodec = audioCodec ?? "?";
	const { hdrPassthrough, hdrLabel } = video;

	return {
		mode: "direct-stream",
		videoTranscode: false,
		audioTranscode: false,
		videoCodec,
		audioStreamIndex,
		audioChannels: file.audioChannels,
		...(hdrPassthrough ? { hdrPassthrough: true } : {}),
		reason: hdrPassthrough
			? `Remuxing to fMP4 HLS (video:${displayVideoCodec} ${hdrLabel} passthrough + audio:${displayAudioCodec} copied)`
			: `Remuxing to fMP4 HLS (video:${displayVideoCodec} + audio:${displayAudioCodec} copied)`,
		reasons: {
			video: hdrPassthrough
				? { code: "video.copy_hdr", params: { codec: videoCodec, hdr: hdrLabel } }
				: { code: "video.copy", params: { codec: videoCodec } },
			audio: { code: "audio.copy", params: { codec: audioCodec } },
		},
		formatName: file.formatName,
		durationSeconds: file.durationSeconds,
		sourceFps: file.sourceFps,
	};
}

function transcodeDecision(input: TranscodeInput): PlaybackDecision {
	const {
		file,
		audioStreamIndex,
		videoCodec,
		audioCodec,
		video,
		audioTranscode,
		videoBitrateKbps,
		bandwidthCappedReason,
		toneMapAvailable,
	} = input;
	const displayVideoCodec = videoCodec ?? "?";
	const displayAudioCodec = audioCodec ?? "?";
	const videoTranscode = !video.videoOk || !!videoBitrateKbps;
	const depthSuffix = bitDepthSuffix(video);
	const rateSuffix = bitrateSuffix(videoBitrateKbps, bandwidthCappedReason);
	const videoReason = videoTranscode
		? videoTranscodeReason(video, displayVideoCodec, depthSuffix, rateSuffix, toneMapAvailable)
		: `video:${displayVideoCodec} copied`;
	const audioReason = audioTranscode ? `audio:${displayAudioCodec} → AAC` : `audio:${displayAudioCodec} copied`;

	const videoPart: PlaybackReasonPart = videoReasonPart({
		video,
		videoTranscode,
		videoCodec,
		depth: depthSuffix,
		videoBitrateKbps,
		toneMapAvailable,
	});
	const audioReasonPart: PlaybackReasonPart = audioTranscode
		? { code: "audio.transcode", params: { codec: audioCodec } }
		: { code: "audio.copy", params: { codec: audioCodec } };

	return {
		mode: "transcode",
		videoTranscode,
		audioTranscode,
		videoCodec,
		videoBitrateKbps,
		tonemap: video.isHdr,
		tonemapTransfer: video.isHdr ? (video.hdrTransfer ?? "smpte2084") : null,
		audioStreamIndex,
		audioChannels: file.audioChannels,
		reason: `${videoReason}; ${audioReason}`,
		reasons: { video: videoPart, audio: audioReasonPart },
		formatName: file.formatName,
		durationSeconds: file.durationSeconds,
		sourceFps: file.sourceFps,
	};
}

export function decidePlaybackMode(
	file: MediaFileInfo,
	capabilities: ClientCapabilities,
	audioStreamIndex?: number,
	{ toneMapAvailable = true }: PlaybackDecisionOptions = {},
): PlaybackDecision {
	const videoCodec = normalizeCodec(file.videoCodec, VIDEO_CODEC_MAP);
	const audioCodec = normalizeCodec(file.audioCodec, AUDIO_CODEC_MAP);
	const video = judgeVideo(file, videoCodec, capabilities);
	const audioOk = !audioCodec || buildCodecSet(capabilities.audioCodecs).has(audioCodec);
	const audioTranscode = !audioOk;

	// Traffic control & bandwidth limit logic
	const serverPerStreamLimit = serverConfig.stream.maxPerStreamBandwidthKbps;
	const clientRequestedBitrate = capabilities.maxBitrate && capabilities.maxBitrate > 0 ? Math.floor(capabilities.maxBitrate) : undefined;
	const sourceBitrateKbps = file.bitRate ? Math.round(file.bitRate / 1000) : undefined;

	const { effectiveBitrateKbps: videoBitrateKbps, bandwidthCappedReason } = planBitrate(
		clientRequestedBitrate,
		sourceBitrateKbps,
		serverPerStreamLimit,
	);
	const plan: PlanInput = { file, audioStreamIndex, videoCodec, audioCodec, video };

	if (video.videoOk && !audioTranscode && !videoBitrateKbps) return directStreamDecision(plan);

	return transcodeDecision({ ...plan, audioTranscode, videoBitrateKbps, bandwidthCappedReason, toneMapAvailable });
}
