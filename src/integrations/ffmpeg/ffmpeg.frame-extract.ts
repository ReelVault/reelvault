import type { FrameExtractionRequest, FrameImageFormat, SpriteExtractionRequest } from "@reelvault/sdk/plugin";
import { FFMPEG_QUIET_ARGS } from "@/integrations/ffmpeg/ffmpeg.args";
import { buildFitPadFilter } from "@/integrations/ffmpeg/ffmpeg.filters";

export function buildFrameExtractionCommand(
	inputPath: string,
	request: FrameExtractionRequest,
	outputPath?: string,
	hwDecodeArgs?: string[],
): string[] {
	const format = request.format ?? "webp";
	const scaleArguments = request.width ? ["-vf", `scale=${request.width}:-2`] : [];

	return [
		...FFMPEG_QUIET_ARGS,
		...(hwDecodeArgs ?? []),
		"-ss",
		(request.timeMs / 1000).toFixed(3),
		"-i",
		inputPath,
		"-frames:v",
		"1",
		...scaleArguments,
		...codecArguments(format),
		...outputTargetArguments(outputPath),
	];
}

export function buildSpriteExtractionCommand(inputPath: string, request: SpriteExtractionRequest, outputPath?: string): string[] {
	const format = request.format ?? "webp";
	const inputs = request.timeMs.flatMap((timeMs) => ["-ss", (timeMs / 1000).toFixed(3), "-i", inputPath]);
	const filters = request.timeMs.map((_, index) => `[${index}:v]${buildFitPadFilter(request.width, request.height)}[s${index}]`);
	const spriteInputs = request.timeMs.map((_, index) => `[s${index}]`).join("");
	const layout = request.timeMs.map((_, index) => spritePosition(index, request.columns)).join("|");

	return [
		...FFMPEG_QUIET_ARGS,
		...inputs,
		"-filter_complex",
		`${filters.join(";")};${spriteInputs}xstack=inputs=${request.timeMs.length}:layout=${layout}[sprite]`,
		"-map",
		"[sprite]",
		"-frames:v",
		"1",
		...codecArguments(format),
		...outputTargetArguments(outputPath),
	];
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
	const filter = buildFitPadFilter(width, height);

	return [
		...FFMPEG_QUIET_ARGS,
		...(hwDecodeArgs ?? []),
		"-ss",
		(timeMs / 1000).toFixed(3),
		"-i",
		inputPath,
		"-frames:v",
		"1",
		"-vf",
		filter,
		...codecArguments(format),
		...outputTargetArguments(outputPath),
	];
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

function spritePosition(index: number, columns: number): string {
	const row = Math.floor(index / columns);
	const column = index % columns;

	return `${stackedDimension("w", column)}_${stackedDimension("h", row)}`;
}

function stackedDimension(dimension: "w" | "h", count: number): string {
	if (count === 0) return "0";

	return Array.from({ length: count }, (_, index) => `${dimension}${index}`).join("+");
}
