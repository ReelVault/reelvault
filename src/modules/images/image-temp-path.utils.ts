import { join } from "node:path";

/** A fresh `.webp` path in the image temp directory; the caller owns the file and moves or deletes it. */
export function createImageTemporaryPath(temporaryDirectory: string): string {
	return join(temporaryDirectory, `${crypto.randomUUID()}.webp`);
}
