import { timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Gunzip, Unzip, UnzipInflate } from "fflate";
import { createHash } from "@/utils/crypto.utils";
import { ValidationError } from "@/utils/errors";
import { guardedFetch } from "@/utils/url-guard.utils";

const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const PLUGIN_ROOT_SEARCH_DEPTH = 3;
const TAR_BLOCK_SIZE = 512;

export interface DownloadedArchive {
	/** Directory holding the download — remove with `cleanup()` once consumed. */
	directory: string;
	filePath: string;
	checksum: string;
	size: number;
	cleanup(): Promise<void>;
}

export interface ExtractedPackage {
	/** Directory inside the extraction root whose root file is `plugin.json`. */
	pluginRoot: string;
	cleanup(): Promise<void>;
}

export interface DownloadArchiveOptions {
	/** Sent as `Authorization: Bearer <token>` for private repositories. */
	token?: string | undefined;
	timeoutMs?: number | undefined;
	maxBytes?: number | undefined;
	/** Test seam — overrides the SSRF-guarded fetcher (production always guards). */
	fetcher?: ArchiveFetcher | undefined;
}

export type ArchiveFetcher = (url: string, init?: { signal?: AbortSignal; headers?: HeadersInit }) => Promise<Response>;

/**
 * Streams a remote archive to a temporary file while hashing it, so the
 * checksum from a catalog manifest can be verified before anything is
 * extracted. Enforces the size cap while streaming — a lying or missing
 * Content-Length cannot overflow the disk.
 */
export async function downloadArchive(url: string, options: DownloadArchiveOptions = {}): Promise<DownloadedArchive> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
	const token = options.token;
	const fetcher = options.fetcher ?? guardedFetch;
	let response: Response;
	try {
		// A catalog manifest's downloadUrl is remote-controlled — every hop must be
		// a public https address, not loopback/RFC1918/cloud-metadata.
		response = await fetcher(url, {
			...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : "unknown error";
		throw new ValidationError(`Failed to download plugin package: ${reason}`);
	}

	if (!response.ok) throw new ValidationError(`Plugin package download failed with HTTP ${response.status}`);

	if (!response.body) throw new ValidationError("Plugin package download returned an empty body");

	const declaredLength = Number(response.headers.get("content-length") ?? 0);
	if (declaredLength > maxBytes) throw new ValidationError(`Plugin package exceeds the ${maxBytes} byte limit`);

	const directory = await mkdtemp(join(tmpdir(), "reelvault-plugin-pkg-"));
	const filePath = join(directory, "package.bin");
	const hasher = createHash("sha256");
	const writer = Bun.file(filePath).writer();
	let received = 0;
	try {
		for await (const chunk of response.body) {
			received += chunk.byteLength;
			if (received > maxBytes) throw new ValidationError(`Plugin package exceeds the ${maxBytes} byte limit`);

			hasher.update(chunk);
			await writer.write(chunk);
		}

		await writer.end();
	} catch (error) {
		try {
			await writer.end();
		} catch {
			// intentionally empty — the sink may already be closed
		}

		await rm(directory, { recursive: true, force: true });
		throw error;
	}

	return {
		directory,
		filePath,
		checksum: `sha256-${hasher.digest("hex")}`,
		size: received,
		cleanup: () => rm(directory, { recursive: true, force: true }),
	};
}

/**
 * Verifies a downloaded archive against the checksum advertised by the
 * catalog manifest before a single byte is extracted.
 */
export function assertChecksumMatches(actual: string, expected: string): void {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
		throw new ValidationError("Plugin package checksum does not match the catalog manifest");
	}
}

/**
 * Extracts a zip or (g)zip'd tar archive into a fresh temporary root and
 * locates the plugin directory inside it. Rejects entry paths that escape
 * the root and refuses to create symlinks/hardlinks. The caller owns
 * `cleanup()`.
 */
export async function extractPluginPackage(
	archivePath: string,
	maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
): Promise<ExtractedPackage> {
	const workRoot = await mkdtemp(join(tmpdir(), "reelvault-plugin-extract-"));
	try {
		const archive = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
		if (archive[0] === 0x52 && archive[1] === 0x61 && archive[2] === 0x72 && archive[3] === 0x21) {
			throw new ValidationError("RAR archives are not supported — repackage the plugin as .zip or .tar.gz");
		}

		if (archive[0] === 0x50 && archive[1] === 0x4b) {
			extractZipEntries(archive, workRoot, maxUncompressedBytes);
		} else if (archive[0] === 0x1f && archive[1] === 0x8b) {
			extractTarEntries(gunzipWithinLimit(archive, maxUncompressedBytes), workRoot, maxUncompressedBytes);
		} else {
			extractTarEntries(archive, workRoot, maxUncompressedBytes);
		}

		const pluginRoot = await locatePluginDirectory(workRoot);

		return { pluginRoot, cleanup: () => rm(workRoot, { recursive: true, force: true }) };
	} catch (error) {
		await rm(workRoot, { recursive: true, force: true });
		throw error;
	}
}

function assertSafeDestination(workRoot: string, entryPath: string): string {
	const normalized = entryPath.replaceAll("\\", "/");
	if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
		throw new ValidationError(`Plugin package contains an unsafe entry path: ${entryPath}`);
	}

	const target = resolve(workRoot, normalized);
	if (target !== workRoot && !target.startsWith(`${workRoot}${sep}`)) {
		throw new ValidationError(`Plugin package contains an unsafe entry path: ${entryPath}`);
	}

	return target;
}

function extractZipEntries(archive: Uint8Array, workRoot: string, maxUncompressedBytes: number): void {
	let total = 0;
	let failure: Error | undefined;
	const unzipper = new Unzip();
	unzipper.register(UnzipInflate);
	unzipper.onfile = (file) => {
		if (failure || file.name.endsWith("/")) return;

		const target = assertSafeDestination(workRoot, file.name);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, new Uint8Array(0));
		file.ondata = (_error, chunk) => {
			if (failure) return;

			// Count the ACTUAL inflated bytes — the zip header's declared size is
			// attacker-controlled and cannot bound a zip bomb.
			total += chunk.byteLength;
			if (total > maxUncompressedBytes) {
				failure = new ValidationError("Plugin package exceeds the uncompressed size limit");

				return;
			}

			appendFileSync(target, chunk);
		};
		file.start();
	};
	unzipper.push(archive, true);
	if (failure) throw failure;
}

/** Streaming gzip inflate with a hard cap on the actual decompressed bytes. */
function gunzipWithinLimit(archive: Uint8Array, maxUncompressedBytes: number): Uint8Array {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let failure: Error | undefined;
	const gunzip = new Gunzip();
	gunzip.ondata = (chunk) => {
		if (failure) return;

		total += chunk.byteLength;
		if (total > maxUncompressedBytes) {
			failure = new ValidationError("Plugin package exceeds the uncompressed size limit");

			return;
		}

		chunks.push(chunk);
	};
	gunzip.push(archive, true);
	if (failure) throw failure;

	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return output;
}

function extractEntry(workRoot: string, entryPath: string, bytes: Uint8Array): void {
	// Synchronous here is fine: zip entries land in memory anyway, and tar is
	// parsed from an in-memory buffer. Package sizes are capped an order of
	// magnitude below what would make this a user-facing stall.
	mkdirSync(dirname(assertSafeDestination(workRoot, entryPath)), { recursive: true });
	writeFileSync(assertSafeDestination(workRoot, entryPath), bytes);
}

const TAR_TYPE_REGULAR = new Set(["0", "\0"]);
const TAR_TYPE_DIRECTORY = "5";
const TAR_TYPE_LONG_NAME = "L";

function extractTarEntries(archive: Uint8Array, workRoot: string, maxUncompressedBytes: number): void {
	let offset = 0;
	let pendingLongName: string | undefined;
	let total = 0;
	while (offset + TAR_BLOCK_SIZE <= archive.length) {
		const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
		if (header.every((byte) => byte === 0)) break;

		offset += TAR_BLOCK_SIZE;

		const size = Number.parseInt(readTarString(header, 124, 12).replace(/[^0-7]/g, ""), 8) || 0;
		const dataEnd = offset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
		const typeFlag = String.fromCharCode(header[156] ?? 0x30);
		const data = archive.subarray(offset, offset + size);
		offset = dataEnd;

		if (typeFlag === TAR_TYPE_LONG_NAME) {
			pendingLongName = readTarString(data, 0, size);
			continue;
		}

		const name = pendingLongName ?? readTarName(header);
		pendingLongName = undefined;

		if (typeFlag === TAR_TYPE_DIRECTORY) {
			assertSafeDestination(workRoot, name);
			continue;
		}

		if (!TAR_TYPE_REGULAR.has(typeFlag)) {
			throw new ValidationError(`Plugin package contains an unsupported tar entry type '${typeFlag}': ${name}`);
		}

		total += size;
		if (total > maxUncompressedBytes) throw new ValidationError(`Plugin package exceeds the uncompressed size limit`);

		extractEntry(workRoot, name, data);
	}
}

function readTarString(block: Uint8Array, offset: number, length: number): string {
	let end = offset;
	const limit = offset + length;
	while (end < limit && block[end] !== 0) end += 1;

	return new TextDecoder().decode(block.subarray(offset, end));
}

/** ustar names: `prefix/name` when the 155-byte prefix field is populated, `name` otherwise. */
function readTarName(header: Uint8Array): string {
	const name = readTarString(header, 0, 100);
	const prefix = readTarString(header, 345, 155);

	return prefix.length > 0 ? `${prefix}/${name}` : name;
}

/** Finds the deepest-shallow directory holding `plugin.json` (zipballs wrap the tree one level down). */
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

	throw new ValidationError("Plugin package does not contain a plugin.json manifest");
}
