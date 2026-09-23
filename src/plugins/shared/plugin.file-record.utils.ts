import { write } from "bun";
import { serverConfig } from "@/server.config";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";

/**
 * Writes `content` to `path` on disk and then runs `persist` (typically a
 * database insert/update that references the written file).
 *
 * If `persist` throws, the just-written file is deleted before the error is
 * rethrown, so a failed database write never leaves an orphaned file behind.
 *
 * This is the "write file, then record it, rollback the file on failure"
 * pattern that used to be hand-rolled identically in the artifacts, blobs,
 * and subtitle-provider services.
 */
export async function writeFileWithRollback<T>(path: string, content: Blob | Uint8Array, persist: () => Promise<T>): Promise<T> {
	await write(path, content);
	try {
		return await persist();
	} catch (error) {
		await FileUtils.delete(path);
		throw error;
	} finally {
		if (content instanceof Blob && "name" in content && typeof content.name === "string") {
			const tempFilePath = content.name;
			if (tempFilePath && PathUtils.isSubpath(tempFilePath, serverConfig.paths.transcodes)) {
				await FileUtils.delete(tempFilePath);
			}
		}
	}
}

/** Returns the byte size of blob/binary content written by plugins, without buffering it into memory. */
export function contentByteSize(content: Blob | Uint8Array): number {
	return content instanceof Blob ? content.size : content.byteLength;
}
