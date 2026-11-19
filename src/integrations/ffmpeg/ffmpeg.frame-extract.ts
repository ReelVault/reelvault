import type { FrameExtractionRequest, FrameImageFormat } from "@reelvault/sdk/plugin";
import { FFMPEG_QUIET_ARGS } from "@/integrations/ffmpeg/ffmpeg.args";
import { buildFitPadFilter } from "@/integrations/ffmpeg/ffmpeg.filters";

interface SingleFrameCommandInput {
	inputPath: string;
	timeMs: number;
	format: FrameImageFormat;
	outputPath?: string | undefined;
	hwDecodeArgs?: string[] | undefined;
	/** The video filter arguments (`-vf …`), or none. */
	filterArgs: string[];
}

/**
 * One decoded frame at a seek position. Automatic threads start a thread per
 * core for a decode that only needs a single picture, and a batch of these runs
 * is the steady state of trickplay and thumbnails, so every frame is single-threaded.
 */
function buildSingleFrameCommand({ inputPath, timeMs, format, outputPath, hwDecodeArgs, filterArgs }: SingleFrameCommandInput): string[] {
	return [
		...FFMPEG_QUIET_ARGS,
		...(hwDecodeArgs ?? []),
		"-threads",
		"1",
		"-ss",
		(timeMs / 1000).toFixed(3),
		"-i",
		inputPath,
		"-frames:v",
		"1",
		...filterArgs,
		...codecArguments(format),
		...outputTargetArguments(outputPath),
	];
}

export function buildFrameExtractionCommand(
	inputPath: string,
	request: FrameExtractionRequest,
	outputPath?: string,
	hwDecodeArgs?: string[],
): string[] {
	return buildSingleFrameCommand({
		inputPath,
		timeMs: request.timeMs,
		format: request.format ?? "webp",
		outputPath,
		hwDecodeArgs,
		filterArgs: request.width ? ["-vf", `scale=${request.width}:-2`] : [],
	});
}

interface SingleFrameExtractionInput {
	inputPath: string;
	timeMs: number;
	width: number;
	height: number;
	format: FrameImageFormat;
	outputPath: string;
	hwDecodeArgs?: string[] | undefined;
}

export function buildSingleFrameExtractionCommand({
	inputPath,
	timeMs,
	width,
	height,
	format,
	outputPath,
	hwDecodeArgs,
}: SingleFrameExtractionInput): string[] {
	return buildSingleFrameCommand({
		inputPath,
		timeMs,
		format,
		outputPath,
		hwDecodeArgs,
		filterArgs: ["-vf", buildFitPadFilter(width, height)],
	});
}

export function buildSpriteTileCommand(
	framesInputPattern: string,
	columns: number,
	rows: number,
	format: FrameImageFormat,
	outputPath: string,
): string[] {
	return [
		...FFMPEG_QUIET_ARGS,
		"-i",
		framesInputPattern,
		"-vf",
		`tile=layout=${columns}x${rows}`,
		...codecArguments(format),
		...outputTargetArguments(outputPath),
	];
}

/** The encoder is chosen by output format — WebP or MJPEG for every extraction command. */
function codecArguments(format: FrameImageFormat): string[] {
	return format === "webp" ? ["-c:v", "libwebp"] : ["-c:v", "mjpeg"];
}

/** `-y <path>` for file outputs; `-f image2pipe -` when the image goes to stdout. */
function outputTargetArguments(outputPath?: string): string[] {
	return outputPath ? ["-y", outputPath] : ["-f", "image2pipe", "-"];
}
