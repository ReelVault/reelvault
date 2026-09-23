import type { CreateMediaFile } from "@sdk/common/media-file.types";
import type { FFProbeResult, FFProbeStream } from "@/integrations/ffprobe/ffprobe.types";
import { selectDefaultOrFirstStream } from "@/modules/streaming/decisions/stream-preferences";
import { escapeRegex } from "@/utils/http.utils";

type MediaFileTechnicalData = Pick<
	CreateMediaFile,
	"formatName" | "duration" | "size" | "bitRate" | "videoStreams" | "audioStreams" | "subtitles"
>;
type MediaFileTagData = Pick<CreateMediaFile, "source" | "edition" | "qualityTag">;

interface FileTagDefinition {
	value: string;
	aliases: readonly string[];
	pattern?: RegExp | undefined;
}
interface ResolutionBucket {
	readonly label: string;
	readonly minWidth: number;
}

const resolutionBuckets: readonly ResolutionBucket[] = [
	{ label: "4320p", minWidth: 7000 },
	{ label: "2160p", minWidth: 3200 },
	{ label: "1440p", minWidth: 2300 },
	{ label: "1080p", minWidth: 1800 },
	{ label: "720p", minWidth: 1200 },
	{ label: "576p", minWidth: 900 },
	{ label: "480p", minWidth: 700 },
	{ label: "360p", minWidth: 500 },
	{ label: "240p", minWidth: 0 },
] as const;

const sourceDefinitions: FileTagDefinition[] = [
	{ value: "WEB-DL", aliases: ["web-dl", "web dl", "webrip", "web rip"] },
	{ value: "BluRay", aliases: ["bluray", "blu-ray", "blu ray", "bdrip", "bd-rip", "bd rip", "brrip", "br-rip", "br rip"] },
	{ value: "Remux", aliases: ["remux"] },
	{ value: "HDTV", aliases: ["hdtv"] },
	{ value: "DVD", aliases: ["dvd", "dvdrip", "dvd-rip", "dvd rip"] },
	{ value: "VHS", aliases: ["vhs"] },
	{ value: "CAM", aliases: ["cam"] },
	{ value: "TS", aliases: ["ts", "telesync"] },
	{ value: "TC", aliases: ["tc", "telecine"] },
];

const editionDefinitions: FileTagDefinition[] = [
	{ value: "Director's Cut", aliases: ["director's cut", "directors cut", "director cut"] },
	{ value: "Special Edition", aliases: ["special edition"] },
	{ value: "Collector's Edition", aliases: ["collector's edition", "collectors edition"] },
	{ value: "Extended", aliases: ["extended", "extended cut"] },
	{ value: "Remastered", aliases: ["remastered", "remaster"] },
	{ value: "Unrated", aliases: ["unrated"] },
	{ value: "Theatrical", aliases: ["theatrical cut", "theatrical"] },
	{ value: "IMAX", aliases: ["imax"] },
	{ value: "Anniversary", aliases: ["anniversary"] },
	{ value: "Ultimate", aliases: ["ultimate edition", "ultimate"] },
	{ value: "Final Cut", aliases: ["final cut"] },
	{ value: "Open Matte", aliases: ["open matte"] },
];

const NON_ALPHANUMERIC = /[^a-z0-9]+/g;

const normalizedSourceDefinitions = normalizeDefinitions(sourceDefinitions);
const normalizedEditionDefinitions = normalizeDefinitions(editionDefinitions);

function resolveQualityTag(width: number | undefined): string | null {
	if (!width) return null;

	return resolutionBuckets.find((bucket) => width >= bucket.minWidth)?.label ?? null;
}

export function mapMediaFileData(fileName: string, probe: FFProbeResult): MediaFileTechnicalData & MediaFileTagData {
	const technicalData = mapMediaProbe(probe);
	const normalizedFileName = normalizeForMatching(fileName);
	const editions = normalizedEditionDefinitions
		.filter((definition) => definition.pattern?.test(normalizedFileName))
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
				bitRate: parseOptionalInteger(stream.bit_rate),
				language: stream.tags?.language ?? null,
				title: stream.tags?.title ?? null,
				isDefault: stream.disposition?.default === 1,
				isForced: stream.disposition?.forced === 1,
			});
		} else if (isUsableAudioStream(stream)) {
			audioStreams.push({
				index: stream.index,
				codecName: stream.codec_name,
				codecLongName: stream.codec_long_name ?? null,
				channels: stream.channels,
				channelLayout: stream.channel_layout ?? null,
				sampleRate: parseOptionalInteger(stream.sample_rate),
				bitRate: parseOptionalInteger(stream.bit_rate),
				language: stream.tags?.language ?? null,
				title: stream.tags?.title ?? null,
				isDefault: stream.disposition?.default === 1,
				isForced: stream.disposition?.forced === 1,
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

function findFirstDefinition(fileName: string, definitions: readonly FileTagDefinition[]): string | null {
	return definitions.find((definition) => definition.pattern?.test(fileName))?.value ?? null;
}

function buildAliasPattern(aliases: readonly string[]): RegExp {
	const escaped = aliases.map((item) => escapeRegex(item));

	return new RegExp(`(?:^|\\s)(?:${escaped.join("|")})(?:\\s|$)`);
}

function normalizeDefinitions(definitions: readonly FileTagDefinition[]): FileTagDefinition[] {
	return definitions.map((definition) => {
		const normalizedAliases = definition.aliases.map(normalizeForMatching);

		return {
			value: definition.value,
			aliases: normalizedAliases,
			pattern: buildAliasPattern(normalizedAliases),
		};
	});
}

function normalizeForMatching(value: string): string {
	return value.toLowerCase().replace(NON_ALPHANUMERIC, " ").trim();
}
