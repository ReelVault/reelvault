import type { ExtractedFrame, FrameExtractionRequest, FrameImageFormat, SpriteExtractionRequest } from "@sdk/plugin";
import { serverConfig } from "@/server.config";
import { ValidationError } from "@/utils/errors";
import { isFiniteNumber } from "@/utils/type.utils";

export function assertFrameExtractionRequest(request: FrameExtractionRequest): void {
	if (!request.mediaFileId)
		throw new ValidationError("Frame extraction failed: 'mediaFileId' is required.", { code: "plugin.ffmpeg.invalid_request" });

	if (!isFiniteNumber(request.timeMs) || request.timeMs < 0) {
		throw new ValidationError(`Frame extraction failed: 'timeMs' must be a non-negative finite number (received: ${request.timeMs}).`, {
			code: "plugin.ffmpeg.invalid_request",
		});
	}

	if (
		request.width !== undefined &&
		(!Number.isInteger(request.width) ||
			request.width < serverConfig.plugins.ffmpeg.minFrameDimension ||
			request.width > serverConfig.plugins.ffmpeg.maxFrameDimension)
	) {
		throw new ValidationError(
			`Frame extraction failed: 'width' (${request.width}) must be an integer between ${serverConfig.plugins.ffmpeg.minFrameDimension} and ${serverConfig.plugins.ffmpeg.maxFrameDimension} px.`,
			{ code: "plugin.ffmpeg.invalid_request" },
		);
	}
}

export function assertSpriteExtractionRequest(request: SpriteExtractionRequest): void {
	if (!request.mediaFileId)
		throw new ValidationError("Sprite extraction failed: 'mediaFileId' is required.", { code: "plugin.ffmpeg.invalid_request" });

	if (!Array.isArray(request.timeMs) || request.timeMs.length === 0) {
		throw new ValidationError("Sprite extraction failed: 'timeMs' array cannot be empty.", { code: "plugin.ffmpeg.invalid_request" });
	}

	if (request.timeMs.length > serverConfig.plugins.ffmpeg.maxSpriteFrames) {
		throw new ValidationError(
			`Sprite extraction failed: 'timeMs' contains ${request.timeMs.length} frames, which exceeds the max limit of ${serverConfig.plugins.ffmpeg.maxSpriteFrames} frames per sprite sheet. To process longer videos, chunk your timestamps into batches of <= ${serverConfig.plugins.ffmpeg.maxSpriteFrames} frames per sprite.`,
			{ code: "plugin.ffmpeg.invalid_request" },
		);
	}

	if (request.timeMs.some((timeMs) => !isFiniteNumber(timeMs) || timeMs < 0)) {
		throw new ValidationError("Sprite extraction failed: 'timeMs' array must contain only non-negative finite millisecond numbers.", {
			code: "plugin.ffmpeg.invalid_request",
		});
	}

	if (
		!(Number.isInteger(request.width) && Number.isInteger(request.height)) ||
		request.width < serverConfig.plugins.ffmpeg.minFrameDimension ||
		request.width > serverConfig.plugins.ffmpeg.maxSpriteWidth ||
		request.height < serverConfig.plugins.ffmpeg.minFrameDimension ||
		request.height > serverConfig.plugins.ffmpeg.maxSpriteHeight
	) {
		throw new ValidationError(
			`Sprite extraction failed: frame dimensions (${request.width}x${request.height}) must be integers from ${serverConfig.plugins.ffmpeg.minFrameDimension}px to ${serverConfig.plugins.ffmpeg.maxSpriteWidth}x${serverConfig.plugins.ffmpeg.maxSpriteHeight}px.`,
			{ code: "plugin.ffmpeg.invalid_request" },
		);
	}

	if (!Number.isInteger(request.columns) || request.columns < 1 || request.columns > request.timeMs.length) {
		throw new ValidationError(
			`Sprite extraction failed: 'columns' (${request.columns}) must be an integer between 1 and the total frame count (${request.timeMs.length}).`,
			{ code: "plugin.ffmpeg.invalid_request" },
		);
	}

	const rows = Math.ceil(request.timeMs.length / request.columns);
	const totalPixels = request.width * request.columns * request.height * rows;
	if (totalPixels > serverConfig.plugins.ffmpeg.maxSpritePixels) {
		throw new ValidationError(
			`Sprite extraction failed: total sprite resolution (${totalPixels} pixels) exceeds the maximum limit of ${serverConfig.plugins.ffmpeg.maxSpritePixels} pixels. Reduce frame dimensions or number of columns/frames.`,
			{ code: "plugin.ffmpeg.invalid_request" },
		);
	}
}

export function contentTypeFor(format: FrameImageFormat): ExtractedFrame["contentType"] {
	return format === "webp" ? "image/webp" : "image/jpeg";
}
