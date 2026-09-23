import type { FrameExtractionRequest, FrameImageFormat, SpriteExtractionRequest } from "@sdk/plugin";

export function buildFrameExtractionCommand(
	inputPath: string,
	request: FrameExtractionRequest,
	outputPath?: string,
	hwDecodeArgs?: string[],
): string[] {
	const format = request.format ?? "webp";
	const outputArguments = format === "webp" ? ["-c:v", "libwebp"] : ["-c:v", "mjpeg"];
	const scaleArguments = request.width ? ["-vf", `scale=${request.width}:-2`] : [];
	const formatOrOverwriteArguments = outputPath ? ["-y"] : ["-f", "image2pipe"];
	const targetOutput = outputPath ?? "-";

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
		...outputArguments,
		...formatOrOverwriteArguments,
		targetOutput,
	];
}

export function buildSpriteExtractionCommand(inputPath: string, request: SpriteExtractionRequest, outputPath?: string): string[] {
	const format = request.format ?? "webp";
	const outputArguments = format === "webp" ? ["-c:v", "libwebp"] : ["-c:v", "mjpeg"];
	const inputs = request.timeMs.flatMap((timeMs) => ["-ss", (timeMs / 1000).toFixed(3), "-i", inputPath]);
	const filters = request.timeMs.map(
		(_, index) =>
			`[${index}:v]scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,pad=${request.width}:${request.height}:(ow-iw)/2:(oh-ih)/2:black[s${index}]`,
	);
	const spriteInputs = request.timeMs.map((_, index) => `[s${index}]`).join("");
	const layout = request.timeMs.map((_, index) => spritePosition(index, request.columns)).join("|");
	const formatOrOverwriteArguments = outputPath ? ["-y"] : ["-f", "image2pipe"];
	const targetOutput = outputPath ?? "-";

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
		...outputArguments,
		...formatOrOverwriteArguments,
		targetOutput,
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
	const outputArguments = format === "webp" ? ["-c:v", "libwebp"] : ["-c:v", "mjpeg"];
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
		...outputArguments,
		"-y",
		outputPath,
	];
}

export function buildSpriteTileCommand(
	framesInputPattern: string,
	columns: number,
	rows: number,
	format: FrameImageFormat,
	outputPath: string,
): string[] {
	const outputArguments = format === "webp" ? ["-c:v", "libwebp"] : ["-c:v", "mjpeg"];

	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		framesInputPattern,
		"-vf",
		`tile=layout=${columns}x${rows}`,
		...outputArguments,
		"-y",
		outputPath,
	];
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
