import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DomainError } from "@/utils/domain.errors";
import { isSubpath } from "@/utils/path.utils";
import { assertSafeDestination, invalidSymlink, unpackedTooLarge } from "./shared.utils";

const TAR_BLOCK_SIZE = 512;

const TAR_TYPE_REGULAR = new Set(["0", "\0"]);
const TAR_TYPE_DIRECTORY = "5";
const TAR_TYPE_SYMLINK = "2";
const TAR_TYPE_LONG_NAME = "L";

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

/** Parser state carried across `push` calls, so a header or entry may span any number of chunks. */
interface TarReader {
	readonly workRoot: string;
	readonly maxUncompressedBytes: number;
	readonly header: Uint8Array;
	headerFilled: number;
	payload: TarPayload | null;
	longNameParts: Uint8Array[];
	pendingLongName: string | undefined;
	readonly symlinks: Array<{ linkPath: string; target: string }>;
	total: number;
	ended: boolean;
}

interface TarEntry {
	name: string;
	size: number;
	padding: number;
}

/**
 * Incremental ustar reader: headers and entry bytes may arrive across arbitrary
 * chunk boundaries, files are written as their data streams in, and symlinks are
 * created in `finish()` because their targets may appear later in the stream.
 * Exported for the chunk-boundary tests.
 */
export function createTarStreamExtractor(workRoot: string, maxUncompressedBytes: number): TarStreamExtractor {
	const reader = createTarReader(workRoot, maxUncompressedBytes);

	return {
		push(chunk) {
			pushTarChunk(reader, chunk);
		},
		finish() {
			finishTarReader(reader);
		},
	};
}

function createTarReader(workRoot: string, maxUncompressedBytes: number): TarReader {
	return {
		workRoot,
		maxUncompressedBytes,
		header: new Uint8Array(TAR_BLOCK_SIZE),
		headerFilled: 0,
		payload: null,
		longNameParts: [],
		pendingLongName: undefined,
		symlinks: [],
		total: 0,
		ended: false,
	};
}

function pushTarChunk(reader: TarReader, chunk: Uint8Array): void {
	if (reader.ended) return;

	let offset = 0;
	while (offset < chunk.byteLength) {
		if (reader.payload) {
			const nextOffset = consumePayload(reader, chunk, offset);
			// The payload is still incomplete — wait for the next chunk.
			if (nextOffset === null) break;

			offset = nextOffset;
			continue;
		}

		const take = Math.min(TAR_BLOCK_SIZE - reader.headerFilled, chunk.byteLength - offset);
		reader.header.set(chunk.subarray(offset, offset + take), reader.headerFilled);
		reader.headerFilled += take;
		offset += take;
		if (reader.headerFilled < TAR_BLOCK_SIZE) break;

		if (consumeHeader(reader)) {
			reader.ended = true;

			break;
		}
	}
}

function finishTarReader(reader: TarReader): void {
	if (!reader.ended && (reader.payload || reader.headerFilled > 0)) {
		throw new DomainError("validation", "Plugin package contains a truncated tar archive", { code: "plugin.archive_truncated" });
	}

	for (const { linkPath, target } of reader.symlinks) {
		mkdirSync(dirname(linkPath), { recursive: true });
		symlinkSync(target, linkPath);
	}
}

/**
 * Consumes payload bytes (file data, long name or discard) plus padding.
 * Returns the new offset, or null when the payload needs more chunks.
 */
function consumePayload(reader: TarReader, chunk: Uint8Array, startOffset: number): number | null {
	const current = reader.payload;
	if (!current) return startOffset;

	let offset = startOffset;
	const take = Math.min(current.remaining, chunk.byteLength - offset);
	if (take > 0) {
		const data = chunk.subarray(offset, offset + take);
		if (current.kind === "file" && current.target) appendFileSync(current.target, data);
		else if (current.kind === "long-name") reader.longNameParts.push(data);

		current.remaining -= take;
		offset += take;
	}

	if (current.remaining > 0) return null;

	const skip = Math.min(current.padding, chunk.byteLength - offset);
	current.padding -= skip;
	offset += skip;
	if (current.padding > 0) return null;

	if (current.kind === "long-name") {
		reader.pendingLongName = decodeTarLongName(reader.longNameParts);
		reader.longNameParts = [];
	}

	reader.payload = null;

	return offset;
}

/** Parses one complete header block; returns true for the end-of-archive marker. */
function consumeHeader(reader: TarReader): boolean {
	const { header } = reader;
	reader.headerFilled = 0;
	if (header.every((byte) => byte === 0)) return true;

	const size = parseTarNumber(header, 124, 12);
	const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
	const typeFlag = String.fromCharCode(header[156] ?? 0x30);

	if (typeFlag === TAR_TYPE_LONG_NAME) {
		reader.payload = { kind: "long-name", remaining: size, padding };

		return false;
	}

	const name = reader.pendingLongName ?? readTarName(header);
	reader.pendingLongName = undefined;
	const entry: TarEntry = { name, size, padding };

	if (typeFlag === TAR_TYPE_DIRECTORY) beginDirectory(reader, entry);
	else if (typeFlag === TAR_TYPE_SYMLINK) beginSymlink(reader, entry);
	else if (TAR_TYPE_REGULAR.has(typeFlag)) beginRegularFile(reader, entry);
	else
		throw new DomainError("validation", `Plugin package contains an unsupported tar entry type '${typeFlag}': ${name}`, {
			code: "plugin.package_entry_unsupported",
			params: { path: name },
		});

	return false;
}

function beginDirectory(reader: TarReader, entry: TarEntry): void {
	// Preserve declared directories (including empty ones) like a real
	// tar reader; files inside would create their parents anyway.
	mkdirSync(assertSafeDestination(reader.workRoot, entry.name), { recursive: true });
	reader.payload = { kind: "discard", remaining: entry.size, padding: entry.padding };
}

function beginSymlink(reader: TarReader, entry: TarEntry): void {
	const { name } = entry;
	const linkPath = assertSafeDestination(reader.workRoot, name);
	const target = readTarString(reader.header, 157, 100);
	if (target.length === 0) throw invalidSymlink(name, "a symlink without a target");
	if (target.startsWith("/")) throw invalidSymlink(name, "an absolute symlink");

	const resolved = resolve(dirname(linkPath), target);
	if (!isSubpath(resolved, reader.workRoot)) throw invalidSymlink(name, "an out-of-tree symlink");

	reader.symlinks.push({ linkPath, target });
	reader.payload = { kind: "discard", remaining: entry.size, padding: entry.padding };
}

function beginRegularFile(reader: TarReader, entry: TarEntry): void {
	reader.total += entry.size;
	if (reader.total > reader.maxUncompressedBytes) throw unpackedTooLarge();

	const target = assertSafeDestination(reader.workRoot, entry.name);
	mkdirSync(dirname(target), { recursive: true });
	const mode = parseTarNumber(reader.header, 100, 8);
	writeFileSync(target, new Uint8Array(0), mode ? { mode: mode & 0o777 } : undefined);
	reader.payload = { kind: "file", target, remaining: entry.size, padding: entry.padding };
}

function parseTarNumber(block: Uint8Array, offset: number, length: number): number {
	return Number.parseInt(readTarString(block, offset, length).replaceAll(/[^0-7]/g, ""), 8) || 0;
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
