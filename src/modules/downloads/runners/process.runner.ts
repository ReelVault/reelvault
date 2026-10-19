import { file } from "bun";
import { serverConfig } from "@/config/server/server.config";
import type { DownloadQuality } from "@/integrations/drizzle-orm/constants/downloads.constants";
import { type DownloadRecord, downloadsStorage } from "@/modules/downloads/downloads.ports";
import { DirUtils } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { PathUtils } from "@/utils/path.utils";
import { detach } from "@/utils/promise.utils";
import { deleteArtifact } from "../artifacts/artifacts.service";
import { promoteQueued } from "../queue.service";
import { type DownloadRunOptions, type DownloadsServiceState, failMissingSource, getStorageQuota } from "../shared.utils";
import { runFfmpeg } from "./ffmpeg.runner";

const FILE_EXTENSION_REGEX = /\.[^.]+$/;
const ILLEGAL_FILENAME_CHARS_REGEX = /["\\/:*?<>|]+/g;

interface PendingDownload {
	row: DownloadRecord;
	filePath: string;
	durationSeconds: number;
	sourceFileName: string;
}

function mediaFileBaseName(sourceFileName: string): string {
	return sourceFileName.replace(FILE_EXTENSION_REGEX, "").replace(ILLEGAL_FILENAME_CHARS_REGEX, "_").slice(0, 120) || "download";
}

/**
 * Runs one download job inside the worker: pending → processing → ffmpeg MP4
 * (faststart) → completed. A `cancelled` row written mid-run makes the exit
 * handler drop the partial file instead of marking completion.
 */
export async function runDownload(state: DownloadsServiceState, downloadId: string, options: DownloadRunOptions = {}): Promise<void> {
	const context = await loadPendingDownload(downloadId);
	if (!context) return;

	const { row, filePath, durationSeconds } = context;

	// Only a free running slot starts the download; otherwise it waits and is started when a slot frees up.
	if (!(await downloadsStorage().claimForProcessing(downloadId, row.profileId, serverConfig.downloads.maxConcurrentPerProfile))) return;

	const outputPath = await resolveOutputPath(downloadId, row.quality, context.sourceFileName);

	try {
		const exitCode = await runFfmpeg(state, { downloadId, filePath, durationSeconds, quality: row.quality, outputPath, options });
		await finalizeDownload({ downloadId, profileId: row.profileId, quality: row.quality, outputPath, exitCode });
	} finally {
		state.abortHandles.delete(downloadId);
		detach(promoteQueued(state, row.profileId));
	}
}

async function loadPendingDownload(downloadId: string): Promise<PendingDownload | null> {
	const row = await downloadsStorage().findById(downloadId);
	if (!row) throw new DomainError("not_found", `Download not found: ${downloadId}`, { code: "download_not_found" });

	if (row.status !== "pending") return null;

	const mediaFile = await downloadsStorage().findMediaFileForDownload(row.mediaFileId);
	if (!mediaFile?.filePath) {
		// Retrying cannot bring the file back, and leaving the row `pending`
		// pinned the profile's single active-download slot forever.
		await failMissingSource(downloadId);

		return null;
	}

	return { row, filePath: mediaFile.filePath, durationSeconds: mediaFile.duration ?? 0, sourceFileName: mediaFile.fileName };
}

async function resolveOutputPath(downloadId: string, quality: string, sourceFileName: string): Promise<string> {
	const baseName = mediaFileBaseName(sourceFileName);
	const fileName = `${baseName}.${quality === "original" ? "mp4" : `${quality}.mp4`}`;
	const outputDir = PathUtils.join(serverConfig.paths.downloads, downloadId);
	await DirUtils.create(outputDir);
	const outputPath = PathUtils.join(outputDir, fileName);
	await downloadsStorage().update(downloadId, { fileName });

	return outputPath;
}

async function finalizeDownload(params: {
	downloadId: string;
	profileId: string;
	quality: DownloadQuality;
	outputPath: string;
	exitCode: number | null;
}): Promise<void> {
	const { downloadId, profileId, quality, outputPath, exitCode } = params;

	const fresh = await downloadsStorage().findById(downloadId);
	if (fresh?.status === "cancelled") {
		await deleteArtifact(outputPath);

		return;
	}

	if (exitCode !== 0) {
		await failFinalizing(downloadId, outputPath, quality === "original" ? "download.source_not_mp4" : "download.ffmpeg_failed");

		return;
	}

	const sizeBytes = file(outputPath).size;
	if (sizeBytes === 0) {
		await failFinalizing(downloadId, outputPath, "download.empty_output");

		return;
	}

	const { maxBytes, usedBytes } = await getStorageQuota(profileId);
	if (maxBytes > 0 && usedBytes + sizeBytes > maxBytes) {
		await failFinalizing(downloadId, outputPath, "download.storage_limit");

		return;
	}

	await downloadsStorage().update(downloadId, { status: "completed", progressPercent: 100, sizeBytes });
}

/** Drops the partial output and records why the download failed. */
async function failFinalizing(downloadId: string, outputPath: string, errorText: string): Promise<void> {
	await deleteArtifact(outputPath);
	await downloadsStorage().update(downloadId, { status: "failed", errorText });
}
