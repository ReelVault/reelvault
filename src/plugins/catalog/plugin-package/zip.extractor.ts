import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UnzipFileHandler } from "fflate";
import { fsErrorCode } from "@/utils/domain.errors";
import { assertSafeDestination, conflictingEntry, unpackedTooLarge } from "./extraction.guard";

/** fflate streams entry data in chunks; the shared counter bounds the whole archive. */
export function createZipEntryHandler(workRoot: string, maxUncompressedBytes: number, onFailure: (error: Error) => void): UnzipFileHandler {
	let total = 0;

	return (file) => {
		if (file.name.endsWith("/")) return;

		const target = assertSafeDestination(workRoot, file.name);
		createEntryFile(target, file.name);
		file.ondata = (_error, chunk) => {
			// Count the ACTUAL inflated bytes — the zip header's declared size is
			// attacker-controlled and cannot bound a zip bomb.
			total += chunk.byteLength;
			if (total > maxUncompressedBytes) {
				onFailure(unpackedTooLarge());

				return;
			}

			appendFileSync(target, chunk);
		};
		file.start();
	};
}

/** An entry that cannot be created because an earlier entry holds its path as a directory (or the reverse) is a malformed package. */
function createEntryFile(target: string, entryPath: string): void {
	try {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, new Uint8Array(0));
	} catch (error) {
		const code = fsErrorCode(error);
		if (code === "EISDIR" || code === "ENOTDIR") throw conflictingEntry(entryPath);

		throw error;
	}
}
