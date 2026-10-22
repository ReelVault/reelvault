import { rm } from "node:fs/promises";
import { join } from "node:path";
import { file } from "bun";
import { serverConfig } from "@/config/server/server.config";
import type { DownloadRow } from "@/repositories/downloads.repository";

const FILE_EXTENSION_REGEX = /\.[^.]+$/;
const ILLEGAL_FILENAME_CHARS_REGEX = /["\\/:*?<>|]+/g;

/** The folder a download writes into: one per download, named after its id. */
export function downloadDirectory(downloadId: string): string {
	return join(serverConfig.paths.downloads, downloadId);
}

/** The file name of a download's MP4: the source name without its extension or illegal characters, plus the quality. */
export function downloadFileName(sourceFileName: string, quality: string): string {
	const baseName =
		sourceFileName.replace(FILE_EXTENSION_REGEX, "").replaceAll(ILLEGAL_FILENAME_CHARS_REGEX, "_").slice(0, 120) || "download";

	return `${baseName}.${quality === "original" ? "mp4" : `${quality}.mp4`}`;
}

/** Completed download as a file handle — never exposes the storage path. */
export async function resolveDownloadFile(row: DownloadRow | null | undefined): Promise<{ fileName: string; blob: Blob } | null> {
	if (row?.status !== "completed" || !row.fileName) return null;

	const handle = file(join(downloadDirectory(row.id), row.fileName));
	if (!(await handle.exists())) return null;

	return { fileName: row.fileName, blob: handle };
}

export async function deleteDownloadFile(row: DownloadRow): Promise<void> {
	if (!row.fileName) return;

	await deleteDownloadOutput(join(downloadDirectory(row.id), row.fileName));
}

/**
 * Deletes a download output under `serverConfig.paths.downloads`. `deleteFile`
 * refuses every video extension (library protection), which would orphan every
 * .mp4 here — downloads own this directory, so the removal bypasses that guard on purpose.
 */
export async function deleteDownloadOutput(path: string): Promise<void> {
	await rm(path, { force: true });
}
