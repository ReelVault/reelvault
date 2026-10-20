import { chmod, rename } from "node:fs/promises";
import { file as bunFile, write as bunWrite } from "bun";
import { FS_STAT_TIMEOUT_MS } from "@/config/server/server.constants";
import { DomainError, fsErrorCode, isMissingFile } from "./domain.errors";
import { createLogger } from "./logger.utils";
import { isVideoFile } from "./path.utils";
import { PromiseTimeoutError, withTimeout } from "./promise.utils";
import { isFiniteNumber, normalizeLower } from "./type.utils";
import { guardedFetch } from "./url-guard.utils";

export async function readFile(path: string, options: "utf8" | "utf-8"): Promise<string>;

export async function readFile(path: string, options?: BufferEncoding | { encoding?: BufferEncoding } | null): Promise<string | Buffer>;

export async function readFile(path: string, options?: BufferEncoding | { encoding?: BufferEncoding } | null): Promise<string | Buffer> {
	const file = bunFile(path);
	const encoding = typeof options === "string" ? options : options?.encoding;
	if (encoding === "utf8" || encoding === "utf-8") {
		return file.text();
	}

	const bytes = await file.bytes();

	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const logger = createLogger("FileUtils");

/** Normalizes every accepted write payload to bytes for the unchanged-content check. */
function toBuffer(content: string | Buffer | ArrayBuffer | Uint8Array): Buffer {
	if (typeof content === "string") return Buffer.from(content);
	if (content instanceof ArrayBuffer) return Buffer.from(content);
	if (Buffer.isBuffer(content)) return content;

	return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}

/**
 * Creates a deterministic temp file path for atomic writes (tmp+rename).
 * @param base - The final destination path
 * @param suffix - Appended after the UUID (default ".tmp")
 * @example createTempPath("/data/file.json") → "/data/file.json.<uuid>.tmp"
 * @example createTempPath("/data/file.json", ".source.tmp") → "/data/file.json.<uuid>.source.tmp"
 */
export function createTempPath(base: string, suffix = ".tmp"): string {
	return `${base}.${crypto.randomUUID()}${suffix.startsWith(".") ? suffix : `.${suffix}`}`;
}

/**
 * Runs `produce` against a fresh temp path beside `basePath` and removes the
 * temp file whatever happens. The producer decides whether to promote it with
 * `rename`; cleanup is never the caller's job.
 */
export async function withTempPath<T>(basePath: string, suffix: string, produce: (tempPath: string) => Promise<T>): Promise<T> {
	const tempPath = createTempPath(basePath, suffix);
	try {
		return await produce(tempPath);
	} finally {
		await deleteFile(tempPath);
	}
}

/**
 * Change-detection signature (size + floored mtime) for cache keys that must
 * invalidate when a file is replaced in place.
 */
export function fileStatSignature(stats: { size: number; mtimeMs: number }): string {
	return `${stats.size}:${Math.floor(stats.mtimeMs)}`;
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;

interface DownloadOptions {
	/** Hard byte cap enforced while streaming, regardless of what Content-Length claims. @default 20MB */
	maxBytes?: number | undefined;
	timeoutMs?: number | undefined;
	signal?: AbortSignal | undefined;
	/** Accepted Content-Type prefixes, e.g. `["image/", "application/octet-stream"]`. Omit to skip the check. */
	allowedContentTypes?: readonly string[] | undefined;
	/** Runs against the temp file before it's moved into place (e.g. sniff the real file type). */
	validate?: ((temporaryPath: string) => Promise<void>) | undefined;
	onError?: ((error: unknown) => void) | undefined;
	/** Test seam only — replaces the SSRF-guarded production fetcher. */
	fetcher?: ((url: string, init?: { signal?: AbortSignal }) => Promise<Response>) | undefined;
}

/** Options for reading a JSON document. `silent` suppresses the error log when an optional file is absent. */
export interface ReadJsonOptions {
	maxSize?: number | undefined;
	silent?: boolean | undefined;
}

export async function readJsonFile<T>(path: string, options?: ReadJsonOptions | number): Promise<T | null>;

export async function readJsonFile(path: string, options?: ReadJsonOptions | number): Promise<unknown> {
	try {
		const maxSize = typeof options === "number" ? options : options?.maxSize;
		if (maxSize !== undefined) {
			const stats = await bunFile(path)
				.stat()
				.catch(() => null);
			if (!stats) return null;

			if (stats.size > maxSize) {
				logger.warn("JSON file too large", {
					filePath: path,
					sizeMb: Number((stats.size / 1024 / 1024).toFixed(2)),
					maxSizeMb: maxSize / 1024 / 1024,
				});

				return null;
			}
		}

		const parsed: unknown = await bunFile(path).json();

		return parsed;
	} catch (error) {
		// Optional files (config.json, ui.json, …) are allowed to be absent.
		const silent = typeof options === "object" && options.silent === true;
		if (silent && isMissingFile(error)) return null;

		logger.error("JSON read error", error, { filePath: path });

		return null;
	}
}

export async function getFileStats(path: string) {
	try {
		return await bunFile(path).stat();
	} catch {
		return null;
	}
}

export async function fileExists(path: string): Promise<boolean> {
	return await bunFile(path).exists();
}

export async function checkFileExistence(path: string): Promise<"exists" | "missing" | "unavailable"> {
	try {
		await withTimeout(bunFile(path).stat(), FS_STAT_TIMEOUT_MS, `stat ${path}`);

		return "exists";
	} catch (error) {
		// A hung stat (dead NFS/CIFS) must read as unreliable storage, never as
		// "missing" — the removal guard purges records on that basis.
		if (error instanceof PromiseTimeoutError) return "unavailable";

		const code = fsErrorCode(error);

		return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
	}
}

export async function writeFile(path: string, content: string | object | Buffer | ArrayBuffer | Uint8Array): Promise<boolean> {
	try {
		const isBinary = Buffer.isBuffer(content) || content instanceof ArrayBuffer || content instanceof Uint8Array;
		const data = typeof content === "object" && !isBinary ? JSON.stringify(content, null, 2) : content;

		await bunWrite(path, data);

		return true;
	} catch (error) {
		logger.error("Write error", error, { filePath: path });

		return false;
	}
}

export async function writeFileAtomic(
	path: string,
	content: string | Buffer | ArrayBuffer | Uint8Array,
	options?: { chmod?: number | undefined },
): Promise<void> {
	const temporaryPath = createTempPath(path);
	try {
		await bunWrite(temporaryPath, content);
		await rename(temporaryPath, path);
		if (options?.chmod !== undefined) {
			await chmod(path, options.chmod).catch(() => {
				// Non-POSIX filesystems may not support chmod — the write still succeeded.
			});
		}
	} finally {
		await deleteFile(temporaryPath);
	}
}

export async function writeFileIfChanged(
	path: string,
	content: string | Buffer | ArrayBuffer | Uint8Array,
	options?: { chmod?: number | undefined },
): Promise<boolean> {
	const incoming = toBuffer(content);
	const existing = await bunFile(path)
		.arrayBuffer()
		.catch(() => null);
	if (existing && Buffer.from(existing).equals(incoming)) return false;

	await writeFileAtomic(path, content, options);

	return true;
}

export async function deleteFile(path: string): Promise<boolean> {
	if (isVideoFile(path)) {
		logger.warn("Refusing to delete video file", { filePath: path });

		return false;
	}

	try {
		await bunFile(path).delete();

		return true;
	} catch {
		return false;
	}
}

export async function downloadFile(url: string, destination: string, options: DownloadOptions = {}): Promise<boolean> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
	const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
	const temporaryPath = createTempPath(destination);
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const effectiveSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	try {
		effectiveSignal.throwIfAborted();
		// SSRF guard (audit 2026-09-15): https-only, resolved addresses must be
		// globally routable, redirects re-validated hop by hop.
		const response = await (options.fetcher ?? guardedFetch)(url, { signal: effectiveSignal });
		if (!response.ok) throw new DomainError("internal", `HTTP ${response.status}`, { code: "download.http_error" });

		if (options.allowedContentTypes?.length) {
			const contentType = normalizeContentType(response.headers.get("content-type"));
			const isAllowed = options.allowedContentTypes.some((prefix) => contentType.startsWith(prefix));
			if (!isAllowed)
				throw new DomainError("internal", `Unexpected content type: ${contentType || "unknown"}`, {
					code: "download.invalid_content_type",
				});
		}

		const declaredSize = Number(response.headers.get("content-length"));
		if (isFiniteNumber(declaredSize) && declaredSize > maxBytes) {
			throw new DomainError("validation", `Download exceeds the ${maxBytes} byte limit`, { code: "download.exceeds_size_limit" });
		}

		if (!response.body) throw new DomainError("internal", "Response has no body", { code: "download.no_body" });

		await streamToFile(response.body, temporaryPath, maxBytes, effectiveSignal);
		if (options.validate) await options.validate(temporaryPath);

		await rename(temporaryPath, destination);

		return true;
	} catch (error) {
		options.onError?.(error);
		// Caller cancellation (worker abort / rescue) is expected, not a failure.
		if (options.signal?.aborted === true) {
			logger.warn("Download cancelled", { filePath: destination });
		} else {
			logger.error("Download error", error, { filePath: destination });
		}
		await bunFile(temporaryPath)
			.delete()
			.catch(() => {
				// Temporary file already removed — nothing to clean.
			});

		return false;
	}
}

export function getFileSize(path: string): number {
	return bunFile(path).size;
}

export function getBunFile(path: string) {
	return bunFile(path);
}

/**
 * Consumes a response body chunk by chunk while enforcing a hard byte cap, so
 * a hostile or misconfigured server cannot buffer an unbounded payload. The
 * caller decides what to do with each chunk (sink write, hash, decode) and
 * which error an overflow raises; the reader is always released.
 */
export async function consumeStreamBounded(
	body: ReadableStream<Uint8Array>,
	{
		maxBytes,
		onChunk,
		signal,
		overflow,
	}: {
		maxBytes: number;
		onChunk: (chunk: Uint8Array, receivedBytes: number) => void | Promise<void>;
		signal?: AbortSignal | undefined;
		overflow: () => Error;
	},
): Promise<number> {
	const reader = body.getReader();
	let receivedBytes = 0;

	try {
		for (;;) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;

			receivedBytes += value.byteLength;
			if (receivedBytes > maxBytes) throw overflow();

			await onChunk(value, receivedBytes);
		}

		return receivedBytes;
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Reader already cancelled or stream already closed.
		}
	}
}

/** Streams a response body to disk via Bun's FileSink, enforcing a hard byte cap without buffering the whole file in memory. */
async function streamToFile(body: ReadableStream<Uint8Array>, path: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
	const sink = bunFile(path).writer();

	try {
		await consumeStreamBounded(body, {
			maxBytes,
			signal,
			overflow: () => new DomainError("validation", `Download exceeds the ${maxBytes} byte limit`, { code: "download.exceeds_size_limit" }),
			onChunk: async (value) => {
				await sink.write(value);
			},
		});
		await sink.end();
	} catch (error) {
		try {
			await sink.end();
		} catch {
			// Sink already closed — nothing left to flush.
		}

		throw error;
	}
}

function normalizeContentType(value: string | null): string {
	return normalizeLower(value?.split(";", 1)[0] ?? "");
}

export function safeParseJson(value: string | null | undefined): unknown {
	if (!value) return null;

	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}
