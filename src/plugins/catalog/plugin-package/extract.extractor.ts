import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { createTarStreamExtractor } from "./tar.extractor";
import { createZipEntryHandler } from "./zip.extractor";

const DEFAULT_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const PLUGIN_ROOT_SEARCH_DEPTH = 3;

interface ExtractedPackage {
	/** Directory inside the extraction root whose root file is `plugin.json`. */
	pluginRoot: string;
	cleanup(): Promise<void>;
}

/**
 * Extracts a zip or (g)zip'd tar archive into `workRoot` (created by the
 * caller). Rejects entry paths that escape the root and refuses to create
 * symlinks/hardlinks. The archive is read and inflated as a stream, so peak
 * memory stays at one chunk instead of the whole compressed archive plus the
 * decompressed payload — shared by plugin packages and the self-update
 * installer, both of which run on small NAS hosts.
 */
export async function extractArchive(
	archivePath: string,
	workRoot: string,
	maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
): Promise<void> {
	const reader = Bun.file(archivePath).stream().getReader();
	try {
		const first = await reader.read();
		if (first.done) return;

		const sink = await createArchiveSink(sniffArchiveType(first.value), workRoot, maxUncompressedBytes);
		sink.dispatch(first.value, false);

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			sink.dispatch(value, false);
		}

		sink.dispatch(new Uint8Array(0), true);
		sink.finish();
	} finally {
		reader.releaseLock();
	}
}

/**
 * Extracts a zip or (g)zip'd tar archive into a fresh temporary root and
 * locates the plugin directory inside it. The caller owns `cleanup()`.
 */
export async function extractPluginPackage(
	archivePath: string,
	maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
): Promise<ExtractedPackage> {
	const workRoot = await mkdtemp(join(tmpdir(), "reelvault-plugin-extract-"));
	try {
		await extractArchive(archivePath, workRoot, maxUncompressedBytes);

		const pluginRoot = await locatePluginDirectory(workRoot);

		return { pluginRoot, cleanup: () => removeTree(workRoot) };
	} catch (error) {
		await removeTree(workRoot);
		throw error;
	}
}

function sniffArchiveType(chunk: Uint8Array): "zip" | "gzip" | "tar" {
	if (chunk[0] === 0x52 && chunk[1] === 0x61 && chunk[2] === 0x72 && chunk[3] === 0x21) {
		throw new DomainError("validation", "RAR archives are not supported — repackage the plugin as .zip or .tar.gz", {
			code: "plugin.archive_format_unsupported",
		});
	}

	if (chunk[0] === 0x50 && chunk[1] === 0x4b) return "zip";
	if (chunk[0] === 0x1f && chunk[1] === 0x8b) return "gzip";

	return "tar";
}

/** Wires the sniffed archive type to its streaming decoder; `finish` flushes and rethrows failures. */
async function createArchiveSink(
	mode: "zip" | "gzip" | "tar",
	workRoot: string,
	maxUncompressedBytes: number,
): Promise<{ dispatch(chunk: Uint8Array, final: boolean): void; finish(): void }> {
	if (mode === "zip") {
		// Loaded per install, not at boot; the streaming loop below stays synchronous.
		const { Unzip, UnzipInflate } = await import("fflate");
		let failure: Error | undefined;
		const unzip = new Unzip();
		unzip.register(UnzipInflate);
		unzip.onfile = createZipEntryHandler(workRoot, maxUncompressedBytes, (error) => {
			failure = error;
		});

		return {
			dispatch(chunk, final) {
				if (failure) return;

				try {
					unzip.push(chunk, final);
				} catch (error) {
					failure = error instanceof Error ? error : new Error(String(error));
				}
			},
			finish() {
				if (failure) throw failure;
			},
		};
	}

	const tar = createTarStreamExtractor(workRoot, maxUncompressedBytes);
	if (mode === "gzip") {
		const { Gunzip } = await import("fflate");
		const gunzip = new Gunzip();
		gunzip.ondata = (data) => tar.push(data);

		return {
			dispatch: (chunk, final) => gunzip.push(chunk, final),
			finish: () => tar.finish(),
		};
	}

	return {
		dispatch: (chunk) => tar.push(chunk),
		finish: () => tar.finish(),
	};
}

/** Finds the shallowest directory holding `plugin.json` (zipballs wrap the tree one level down). */
async function locatePluginDirectory(root: string): Promise<string> {
	const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;

		const entries = await readdir(current.directory, { withFileTypes: true });
		if (entries.some((entry) => entry.isFile() && entry.name === "plugin.json")) return current.directory;

		if (current.depth >= PLUGIN_ROOT_SEARCH_DEPTH) continue;

		for (const entry of entries) {
			if (entry.isDirectory() && !entry.name.startsWith(".")) {
				queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 });
			}
		}
	}

	throw new DomainError("validation", "Plugin package does not contain a plugin.json manifest", { code: "plugin.manifest_missing" });
}
