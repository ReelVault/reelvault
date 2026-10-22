import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UnzipFileHandler } from "fflate";
import { assertSafeDestination, unpackedTooLarge } from "./extraction.guard";

/** fflate streams entry data in chunks; the shared counter bounds the whole archive. */
export function createZipEntryHandler(workRoot: string, maxUncompressedBytes: number, onFailure: (error: Error) => void): UnzipFileHandler {
	let total = 0;

	return (file) => {
		if (file.name.endsWith("/")) return;

		const target = assertSafeDestination(workRoot, file.name);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, new Uint8Array(0));
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
