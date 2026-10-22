import { systemResourcesService } from "@/config/system-resources.service";
import { parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { videoParser } from "@/modules/scanner/probe/video-parser.service";
import { mediaRepository } from "@/repositories/media-files.repository";
import { assertFound, errorCodeOf } from "@/utils/domain.errors";
import { getFileStats } from "@/utils/file.utils";
import { createSemaphore } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { mediaFilesLog } from "./media-files.logger";

// Concurrency guard for on-demand ffmpeg/ffprobe integrity scans triggered from the API.
// Each permit is an ffmpeg decode — derived from measured CPU capacity
// (admin's scanning.concurrency override is honored inside the getter).
const scanSemaphore = createSemaphore(() => systemResourcesService.getScannerConcurrency());

export interface MediaFileScanResult {
	exists: boolean;
	readable: boolean;
	sizeBytes: number | null;
	probeSuccess: boolean;
	probeErrorCode: string | null;
	decodeSuccess: boolean;
	decodeErrorCode: string | null;
	isEnabled: boolean;
}

/** Existence and readability of the file on disk; a missing or inaccessible file counts as absent. */
async function probeFileStats(filePath: string): Promise<{ exists: boolean; readable: boolean; sizeBytes: number | null }> {
	let exists = false;
	let readable = false;
	let sizeBytes: number | null = null;

	try {
		const stats = await getFileStats(filePath);
		if (stats) {
			exists = true;
			readable = stats.isFile();
			sizeBytes = stats.size;
		}
	} catch {
		// File not found or not accessible
	}

	return { exists, readable, sizeBytes };
}

async function probeMediaFile(filePath: string): Promise<{ probeSuccess: boolean; probeErrorCode: string | null }> {
	try {
		const probe = await videoParser.probe(filePath);
		if (probe) return { probeSuccess: true, probeErrorCode: null };

		return { probeSuccess: false, probeErrorCode: "media.probe_no_data" };
	} catch (error) {
		return { probeSuccess: false, probeErrorCode: errorCodeOf(error, "media.probe_failed") };
	}
}

/** Decodes the first `durationSeconds` (60 by default) of the file with ffmpeg; a failed decode is recorded, not thrown. */
async function decodeMediaFile(
	filePath: string,
	durationSeconds: number | null | undefined,
): Promise<{ decodeSuccess: boolean; decodeErrorCode: string | null }> {
	try {
		const args = ["-v", "error"];
		const scanDuration = durationSeconds === undefined ? 60 : durationSeconds;
		if (scanDuration && scanDuration > 0) {
			args.push("-t", String(scanDuration));
		}

		args.push("-i", filePath, "-f", "null", "-");

		const ffmpegResult = await ffMpegService.runToCompletion(args, { stdout: "ignore" });
		if (ffmpegResult.exitCode === 0) return { decodeSuccess: true, decodeErrorCode: null };

		return { decodeSuccess: false, decodeErrorCode: "media.decode_failed" };
	} catch (error) {
		return { decodeSuccess: false, decodeErrorCode: errorCodeOf(error, "media.decode_failed") };
	}
}

export async function scan(mediaFileId: string, options?: { durationSeconds?: number | null } | null): Promise<MediaFileScanResult> {
	return await scanSemaphore.run(async () => {
		return await runSafely(mediaFilesLog, "scan", async () => {
			const mediaFile = await mediaRepository.findByPrimaryId({
				primaryId: mediaFileId,
				fields: parseFields({ fields: "id,filePath,isEnabled" }),
			});
			assertFound(mediaFile, "MediaFile", mediaFileId);

			const filePath = mediaFile.filePath;
			const { exists, readable, sizeBytes } = await probeFileStats(filePath);

			if (!exists) {
				return {
					isEnabled: false,
					exists: false,
					readable: false,
					sizeBytes: null,
					probeSuccess: false,
					probeErrorCode: "media.file_missing",
					decodeSuccess: false,
					decodeErrorCode: "media.file_missing",
				};
			}

			const { probeSuccess, probeErrorCode } = await probeMediaFile(filePath);

			const { decodeSuccess, decodeErrorCode } = await decodeMediaFile(filePath, options?.durationSeconds);

			// `exists` was already asserted by the early return above.
			const hasErrors = !(readable && probeSuccess && decodeSuccess);
			let isEnabled = mediaFile.isEnabled;

			const shouldBeEnabled = !hasErrors;
			if (mediaFile.isEnabled !== shouldBeEnabled) {
				await mediaRepository.update({ primaryId: mediaFileId, values: { isEnabled: shouldBeEnabled } });
				isEnabled = shouldBeEnabled;
			}

			return {
				exists,
				readable,
				sizeBytes,
				probeSuccess,
				probeErrorCode,
				decodeSuccess,
				decodeErrorCode,
				isEnabled,
			};
		});
	});
}
