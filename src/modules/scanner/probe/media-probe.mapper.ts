import type { CreateMediaFile } from "@reelvault/sdk/common";
import type { FFProbeResult, FFProbeStream, FfprobeAudioStream, VideoStream } from "@/integrations/ffprobe/ffprobe.types";
import { selectDefaultOrFirstStream } from "@/modules/streaming/decisions/stream-preferences";
import { escapeRegex } from "@/utils/http.utils";
import {
	EDITION_TAGS,
	normalizeForMatching,
	RESOLUTION_BUCKETS,
	type ReleaseTagDefinition,
	SOURCE_TAGS,
} from "@/utils/release-tags.constants";

type MediaFileTechnicalData = Pick<
	CreateMediaFile,
	"formatName" | "duration" | "size" | "bitRate" | "videoStreams" | "audioStreams" | "subtitles"
>;
type MediaFileTagData = Pick<CreateMediaFile, "source" | "edition" | "qualityTag">;

interface CompiledFileTagDefinition {
	value: string;
	pattern: RegExp;
}

const normalizedSourceDefinitions = normalizeDefinitions(SOURCE_TAGS);
const normalizedEditionDefinitions = normalizeDefinitions(EDITION_TAGS);

function resolveQualityTag(width: number | undefined): string | null {
	if (!width) return null;

	return RESOLUTION_BUCKETS.find((bucket) => width >= bucket.minWidth)?.label ?? null;
}

export function mapMediaFileData(fileName: string, probe: FFProbeResult): MediaFileTechnicalData & MediaFileTagData {
	const technicalData = mapMediaProbe(probe);
	const normalizedFileName = normalizeForMatching(fileName);
	const editions = normalizedEditionDefinitions
		.filter((definition) => definition.pattern.test(normalizedFileName))
		.map((definition) => definition.value);
	const videoStream = selectDefaultOrFirstStream(technicalData.videoStreams);

	return {
		...technicalData,
		source: findFirstDefinition(normalizedFileName, normalizedSourceDefinitions),
		edition: editions.length > 0 ? editions.join(", ") : null,
		qualityTag: resolveQualityTag(videoStream?.width),
	};
}

export function mapMediaProbe(tech: FFProbeResult): MediaFileTechnicalData {
	const videoStreams: MediaFileTechnicalData["videoStreams"] = [];
	const audioStreams: MediaFileTechnicalData["audioStreams"] = [];
	const subtitles: MediaFileTechnicalData["subtitles"] = [];

	for (const stream of tech.streams) {
		if (isUsableVideoStream(stream)) {
			const doviRecord = stream.side_data_list?.find((sideData) => sideData.side_data_type === "DOVI configuration record");
			videoStreams.push({
				index: stream.index,
				codecName: stream.codec_name,
				codecLongName: stream.codec_long_name ?? null,
				profile: stream.profile ?? null,
				height: stream.height,
				width: stream.width,
				pixelFormat: stream.pix_fmt ?? null,
				colorTransfer: stream.color_transfer ?? null,
				colorPrimaries: stream.color_primaries ?? null,
				colorSpace: stream.color_space ?? null,
				doviProfile: doviRecord?.dv_profile ?? null,
				frameRate: stream.avg_frame_rate ?? null,
				...mapSharedStreamFields(stream),
			});
		} else if (isUsableAudioStream(stream)) {
			audioStreams.push({
				index: stream.index,
				codecName: stream.codec_name,
				codecLongName: stream.codec_long_name ?? null,
				channels: stream.channels,
				channelLayout: stream.channel_layout ?? null,
				sampleRate: parseOptionalInteger(stream.sample_rate),
				...mapSharedStreamFields(stream),
				isCommentary: stream.disposition?.comment === 1,
			});
		} else {
			subtitles.push({
				language: stream.tags?.language ?? "und",
				label: stream.tags?.title ?? null,
				format: stream.codec_name,
				streamIndex: stream.index,
				isDefault: stream.disposition?.default === 1,
				isForced: stream.disposition?.forced === 1,
				isHearingImpaired: stream.disposition?.hearing_impaired === 1,
			});
		}
	}

	return {
		formatName: tech.format.format_name ?? "",
		duration: parseInteger(tech.format.duration, -1),
		size: parseInteger(tech.format.size, -1),
		bitRate: parseInteger(tech.format.bit_rate, -1),
		videoStreams,
		audioStreams,
		subtitles,
	};
}

/** Stream fields whose mapping is identical for video and audio rows. */
function mapSharedStreamFields(stream: VideoStream | FfprobeAudioStream) {
	return {
		bitRate: parseOptionalInteger(stream.bit_rate),
		language: stream.tags?.language ?? null,
		title: stream.tags?.title ?? null,
		isDefault: stream.disposition?.default === 1,
		isForced: stream.disposition?.forced === 1,
	};
}

function parseInteger(value: string | undefined, fallback: number): number {
	const parsed = parseOptionalInteger(value);

	return parsed ?? fallback;
}

function isUsableVideoStream(stream: FFProbeStream): stream is Extract<FFProbeStream, { codec_type: "video" }> {
	if (stream.codec_type !== "video") return false;

	// MKV cover art / attached pictures are not playable streams.
	if (stream.disposition?.attached_pic === 1) return false;

	// Rows without real dimensions violate the table's CHECK constraint (width/height > 0).
	return stream.width > 0 && stream.height > 0;
}

function isUsableAudioStream(stream: FFProbeStream): stream is Extract<FFProbeStream, { codec_type: "audio" }> {
	if (stream.codec_type !== "audio") return false;

	// Rows without channels violate the table's CHECK constraint (channels > 0).
	return stream.channels > 0;
}

function parseOptionalInteger(value: string | undefined): number | null {
	const parsed = Number.parseInt(value ?? "", 10);

	return Number.isNaN(parsed) ? null : parsed;
}

function findFirstDefinition(fileName: string, definitions: readonly CompiledFileTagDefinition[]): string | null {
	return definitions.find((definition) => definition.pattern.test(fileName))?.value ?? null;
}

function buildAliasPattern(aliases: readonly string[]): RegExp {
	const escaped = aliases.map((item) => escapeRegex(item));

	return new RegExp(`(?:^|\\s)(?:${escaped.join("|")})(?:\\s|$)`);
}

function normalizeDefinitions(definitions: readonly ReleaseTagDefinition[]): CompiledFileTagDefinition[] {
	return definitions.map((definition) => ({
		value: definition.value,
		pattern: buildAliasPattern(definition.aliases.map(normalizeForMatching)),
	}));
}
