import { readdir } from "node:fs/promises";
import { file } from "bun";
import { createHash } from "@/utils/crypto.utils";
import { ValidationError } from "@/utils/errors";
import { PathUtils } from "@/utils/path.utils";

/** Admin-owned runtime state at the package root — mutable, so excluded from the hash. */
export const MUTABLE_CONFIG_FILENAME = "config.json";

export async function calculateDirectoryIntegrity(directory: string): Promise<string> {
	const hash = createHash("sha256");
	await updateIntegrityHash(hash, directory, directory);

	return `sha256-${hash.digest("base64")}`;
}

/**
 * Updates `hash` with every entry of the directory tree. Entries are sorted by
 * name and files are streamed in chunks so large plugin assets are never read
 * into memory whole — the update order stays deterministic.
 */
async function updateIntegrityHash(hash: ReturnType<typeof createHash>, root: string, directory: string): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	const isRoot = directory === root;
	for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
		if (isRoot && entry.name === MUTABLE_CONFIG_FILENAME) continue;

		const path = PathUtils.join(directory, entry.name);
		const relativePath = path.slice(root.length + 1).replaceAll("\\", "/");
		if (entry.isDirectory()) {
			hash.update(`directory:${relativePath}\0`);
			await updateIntegrityHash(hash, root, path);
			continue;
		}

		if (!entry.isFile()) throw new ValidationError(`Plugin package contains an unsupported filesystem entry: ${path}`);

		hash.update(`file:${relativePath}\0`);
		const stream = file(path).stream();
		for await (const chunk of stream) {
			hash.update(chunk);
		}
	}
}
