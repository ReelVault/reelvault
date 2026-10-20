import { rm } from "node:fs/promises";
import { file } from "bun";
import { serverConfig } from "@/config/server/server.config";
import type { DownloadRecord } from "@/modules/downloads/downloads.ports";
import { joinPath } from "@/utils/path.utils";

function artifactPath(downloadId: string, fileName: string): string {
	return joinPath(serverConfig.paths.downloads, downloadId, fileName);
}

/** Completed download as a file handle — never exposes the storage path. */
export async function resolveFileFromRow(row: DownloadRecord | null | undefined): Promise<{ fileName: string; blob: Blob } | null> {
	if (row?.status !== "completed" || !row.fileName) return null;

	const path = artifactPath(row.id, row.fileName);
	const handle = file(path);
	if (!(await handle.exists())) return null;

	return { fileName: row.fileName, blob: handle };
}

export async function deleteArtifactFile(row: DownloadRecord): Promise<void> {
	if (!row.fileName) return;

	await deleteArtifact(artifactPath(row.id, row.fileName));
}

/** Deletes a download artifact under serverConfig.paths.downloads.
 * deleteFile refuses every video extension (library protection), which
 * would silently orphan every .mp4 artifact here — downloads own this
 * directory, so the removal bypasses that guard on purpose. */
export async function deleteArtifact(path: string): Promise<void> {
	await rm(path, { force: true });
}
