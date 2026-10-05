import type { FrameExtractionRequest, FrameImageFormat, SpriteExtractionRequest } from "@reelvault/sdk/plugin";

export function buildFrameExtractionCommand(
	inputPath: string,
	request: FrameExtractionRequest,
	outputPath?: string,
	hwDecodeArgs?: string[],
): string[] {
	const format = request.format ?? "webp";
	const scaleArguments = request.width ? ["-vf", `scale=${request.width}:-2`] : [];

	return [
		"-hide_banner",
		"-loglevel",
		"error",
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
	const filters = request.timeMs.map(
		(_, index) =>
			`[${index}:v]scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,pad=${request.width}:${request.height}:(ow-iw)/2:(oh-ih)/2:black[s${index}]`,
	);
	const spriteInputs = request.timeMs.map((_, index) => `[s${index}]`).join("");
	const layout = request.timeMs.map((_, index) => spritePosition(index, request.columns)).join("|");

	return [
		"-hide_banner",
		"-loglevel",
		"error",
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

export function buildSingleFrameExtractionCommand(
	inputPath: string,
	timeMs: number,
	width: number,
	height: number,
	format: FrameImageFormat,
	outputPath: string,
	hwDecodeArgs?: string[],
): string[] {
	const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;

	return [
		"-hide_banner",
		"-loglevel",
		"error",
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
		"-hide_banner",
		"-loglevel",
		"error",
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
