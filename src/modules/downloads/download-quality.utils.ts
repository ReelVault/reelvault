import { parseColonSeparatedSeconds } from "@/utils/time.utils";

export type DownloadQuality = "original" | "1080p-high" | "720p-mobile" | "480p-low";

export const DOWNLOAD_QUALITIES: readonly DownloadQuality[] = ["original", "1080p-high", "720p-mobile", "480p-low"];
const DOWNLOAD_QUALITIES_SET = new Set<string>(DOWNLOAD_QUALITIES);

export const DOWNLOAD_STATUSES = ["pending", "processing", "completed", "failed", "cancelled"] as const;

export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number];

export interface DownloadQualitySpec {
	/** Output width; 0 = keep source. */
	width: number;
	/** Output height; 0 = keep source. */
	height: number;
	/** Video bitrate in kbps; 0 = stream copy (original only). */
	videoBitrateKbps: number;
	label: string;
}

const SPECS: Record<DownloadQuality, DownloadQualitySpec> = {
	original: { width: 0, height: 0, videoBitrateKbps: 0, label: "Original (FastStart)" },
	"1080p-high": { width: 1920, height: 1080, videoBitrateKbps: 6000, label: "1080p" },
	"720p-mobile": { width: 1280, height: 720, videoBitrateKbps: 2500, label: "720p" },
	"480p-low": { width: 854, height: 480, videoBitrateKbps: 1200, label: "480p" },
};

export function isDownloadQuality(value: string): value is DownloadQuality {
	return DOWNLOAD_QUALITIES_SET.has(value);
}

export function resolveDownloadQuality(quality: string): DownloadQualitySpec {
	return isDownloadQuality(quality) ? SPECS[quality] : SPECS["720p-mobile"];
}

/** ffmpeg `-ss`-style progress time (`[[HH:]MM:]SS.xx`) → seconds (0 on invalid input). */
export function ffmpegTimeToSeconds(value: string): number {
	return parseColonSeparatedSeconds(value) || 0;
}

/**
 * Output args for an offline-download MP4. `original` stream-copies (source
 * must already be MP4-compatible — the job fails with a clear error otherwise),
 * the re-encode presets scale to the target size and cap the bitrate.
 */
export function buildDownloadOutputArgs(quality: DownloadQuality, sourceDurationSeconds: number): string[] {
	const spec = resolveDownloadQuality(quality);
	if (quality === "original") {
		return ["-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart"];
	}

	const durationGuard = sourceDurationSeconds > 0 ? ["-t", String(Math.ceil(sourceDurationSeconds))] : [];

	return [
		"-map",
		"0:v:0",
		"-map",
		"0:a:0",
		"-vf",
		`scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease,pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2:black`,
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-b:v",
		`${spec.videoBitrateKbps}k`,
		"-maxrate",
		`${Math.round(spec.videoBitrateKbps * 1.25)}k`,
		"-bufsize",
		`${spec.videoBitrateKbps * 2}k`,
		"-c:a",
		"aac",
		"-b:a",
		"192k",
		"-movflags",
		"+faststart",
		...durationGuard,
	];
}
