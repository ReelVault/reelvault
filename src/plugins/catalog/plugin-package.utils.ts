import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Gunzip, Unzip, type UnzipFileHandler, UnzipInflate } from "fflate";
import { constantTimeEquals, createHash } from "@/utils/crypto.utils";
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
	/** Streaming download progress — `total` is 0 when the server sends no Content-Length. */
	onProgress?: ((received: number, total: number) => void) | undefined;
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
			options.onProgress?.(received, declaredLength);
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
	if (!constantTimeEquals(actual, expected)) {
		throw new ValidationError("Plugin package checksum does not match the catalog manifest");
	}
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

		const sink = createArchiveSink(sniffArchiveType(first.value), workRoot, maxUncompressedBytes);
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

function sniffArchiveType(chunk: Uint8Array): "zip" | "gzip" | "tar" {
	if (chunk[0] === 0x52 && chunk[1] === 0x61 && chunk[2] === 0x72 && chunk[3] === 0x21) {
		throw new ValidationError("RAR archives are not supported — repackage the plugin as .zip or .tar.gz");
	}

	if (chunk[0] === 0x50 && chunk[1] === 0x4b) return "zip";
	if (chunk[0] === 0x1f && chunk[1] === 0x8b) return "gzip";

	return "tar";
}

/** Wires the sniffed archive type to its streaming decoder; `finish` flushes and rethrows failures. */
function createArchiveSink(
	mode: "zip" | "gzip" | "tar",
	workRoot: string,
	maxUncompressedBytes: number,
): { dispatch(chunk: Uint8Array, final: boolean): void; finish(): void } {
	if (mode === "zip") {
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
		await extractArchive(archivePath, workRoot, maxUncompressedBytes);

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

/** fflate streams entry data in chunks; the shared counter bounds the whole archive. */
function createZipEntryHandler(workRoot: string, maxUncompressedBytes: number, onFailure: (error: Error) => void): UnzipFileHandler {
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
				onFailure(new ValidationError("Plugin package exceeds the uncompressed size limit"));

				return;
			}

			appendFileSync(target, chunk);
		};
		file.start();
	};
}

interface TarStreamExtractor {
	push(chunk: Uint8Array): void;
	/** Creates the deferred symlinks and rejects a stream that ended mid-entry. */
	finish(): void;
}

interface TarPayload {
	kind: "file" | "long-name" | "discard";
	target?: string;
	remaining: number;
	padding: number;
}

const TAR_TYPE_REGULAR = new Set(["0", "\0"]);
const TAR_TYPE_DIRECTORY = "5";
const TAR_TYPE_SYMLINK = "2";
const TAR_TYPE_LONG_NAME = "L";

/**
 * Incremental ustar reader: headers and entry bytes may arrive across arbitrary
 * chunk boundaries, files are written as their data streams in, and symlinks are
 * created in `finish()` because their targets may appear later in the stream.
 * Exported for the chunk-boundary tests.
 */
export function createTarStreamExtractor(workRoot: string, maxUncompressedBytes: number): TarStreamExtractor {
	const header = new Uint8Array(TAR_BLOCK_SIZE);
	let headerFilled = 0;
	let payload: TarPayload | null = null;
	let longNameParts: Uint8Array[] = [];
	let pendingLongName: string | undefined;
	const symlinks: Array<{ linkPath: string; target: string }> = [];
	let total = 0;
	const state = { ended: false };

	/**
	 * Consumes payload bytes (file data, long name or discard) plus padding.
	 * Returns the new offset, or null when the payload needs more chunks.
	 */
	const consumePayload = (chunk: Uint8Array, startOffset: number): number | null => {
		if (!payload) return startOffset;

		const current = payload;
		let offset = startOffset;
		const take = Math.min(current.remaining, chunk.byteLength - offset);
		if (take > 0) {
			const data = chunk.subarray(offset, offset + take);
			if (current.kind === "file" && current.target) appendFileSync(current.target, data);
			else if (current.kind === "long-name") longNameParts.push(data);

			current.remaining -= take;
			offset += take;
		}

		if (current.remaining > 0) return null;

		const skip = Math.min(current.padding, chunk.byteLength - offset);
		current.padding -= skip;
		offset += skip;
		if (current.padding > 0) return null;

		if (current.kind === "long-name") {
			pendingLongName = decodeTarLongName(longNameParts);
			longNameParts = [];
		}

		payload = null;

		return offset;
	};

	/** Parses one complete header block; returns true for the end-of-archive marker. */
	const consumeHeader = (): boolean => {
		headerFilled = 0;
		if (header.every((byte) => byte === 0)) return true;

		const size = parseTarNumber(header, 124, 12);
		const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
		const typeFlag = String.fromCharCode(header[156] ?? 0x30);

		if (typeFlag === TAR_TYPE_LONG_NAME) {
			payload = { kind: "long-name", remaining: size, padding };

			return false;
		}

		const name = pendingLongName ?? readTarName(header);
		pendingLongName = undefined;

		if (typeFlag === TAR_TYPE_DIRECTORY) {
			// Preserve declared directories (including empty ones) like a real
			// tar reader; files inside would create their parents anyway.
			mkdirSync(assertSafeDestination(workRoot, name), { recursive: true });
			payload = { kind: "discard", remaining: size, padding };

			return false;
		}

		if (typeFlag === TAR_TYPE_SYMLINK) {
			const linkPath = assertSafeDestination(workRoot, name);
			const target = readTarString(header, 157, 100);
			if (target.length === 0) throw new ValidationError(`Plugin package contains a symlink without a target: ${name}`);
			if (target.startsWith("/")) throw new ValidationError(`Plugin package contains an absolute symlink: ${name}`);

			const resolved = resolve(dirname(linkPath), target);
			if (!resolved.startsWith(`${workRoot}${sep}`)) {
				throw new ValidationError(`Plugin package contains an out-of-tree symlink: ${name}`);
			}

			symlinks.push({ linkPath, target });
			payload = { kind: "discard", remaining: size, padding };

			return false;
		}

		if (!TAR_TYPE_REGULAR.has(typeFlag)) {
			throw new ValidationError(`Plugin package contains an unsupported tar entry type '${typeFlag}': ${name}`);
		}

		total += size;
		if (total > maxUncompressedBytes) throw new ValidationError("Plugin package exceeds the uncompressed size limit");

		const target = assertSafeDestination(workRoot, name);
		mkdirSync(dirname(target), { recursive: true });
		const mode = parseTarNumber(header, 100, 8);
		writeFileSync(target, new Uint8Array(0), mode ? { mode: mode & 0o777 } : undefined);
		payload = { kind: "file", target, remaining: size, padding };

		return false;
	};

	return {
		push(chunk) {
			if (state.ended) return;

			let offset = 0;
			while (offset < chunk.byteLength) {
				if (payload) {
					const nextOffset = consumePayload(chunk, offset);
					// The payload is still incomplete — wait for the next chunk.
					if (nextOffset === null) break;

					offset = nextOffset;
					continue;
				}

				const take = Math.min(TAR_BLOCK_SIZE - headerFilled, chunk.byteLength - offset);
				header.set(chunk.subarray(offset, offset + take), headerFilled);
				headerFilled += take;
				offset += take;
				if (headerFilled < TAR_BLOCK_SIZE) break;

				if (consumeHeader()) {
					state.ended = true;

					break;
				}
			}
		},
		finish() {
			if (!state.ended && (payload || headerFilled > 0)) {
				throw new ValidationError("Plugin package contains a truncated tar archive");
			}

			for (const { linkPath, target } of symlinks) {
				mkdirSync(dirname(linkPath), { recursive: true });
				symlinkSync(target, linkPath);
			}
		},
	};
}

function parseTarNumber(block: Uint8Array, offset: number, length: number): number {
	return Number.parseInt(readTarString(block, offset, length).replace(/[^0-7]/g, ""), 8) || 0;
}

function decodeTarLongName(parts: Uint8Array[]): string {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}

	return readTarString(joined, 0, joined.byteLength);
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
