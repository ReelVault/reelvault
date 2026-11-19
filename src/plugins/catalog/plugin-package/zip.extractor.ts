import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UnzipFileHandler } from "fflate";
import { assertSafeDestination, unpackedTooLarge, writeEntry } from "./extraction.guard";

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

/** Creates an empty entry file; a path clash with an earlier entry is reported as a conflict. */
function createEntryFile(target: string, entryPath: string): void {
	writeEntry(entryPath, () => {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, new Uint8Array(0));
	});
}
