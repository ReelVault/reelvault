import { write } from "bun";
import { serverConfig } from "@/server.config";
import { DirUtils } from "@/utils/directory.utils";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";

/**
 * Creates `directory` once per process and returns an idempotent ensurer. A
 * failed attempt is not cached — the next call retries. `failure` builds the
 * caller's domain error so error types/codes stay with each service.
 */
export function createDirectoryOnce(directory: string, failure: () => Error): () => Promise<void> {
	let ready: Promise<void> | undefined;

	return async () => {
		ready ??= (async () => {
			if (!(await DirUtils.create(directory))) throw failure();
		})();

		try {
			await ready;
		} catch (error) {
			ready = undefined;
			throw error;
		}
	};
}

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
