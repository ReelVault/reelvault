import { chmod, rename, stat, unlink } from "node:fs/promises";
import { file as bunFile, write as bunWrite } from "bun";
import { InternalError, isMissingFile, ValidationError } from "./errors";
import { createLogger } from "./logger";
import { PathUtils } from "./path.utils";
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

/** Reads the POSIX error code from a thrown fs error without a type assertion. */
function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;

	return undefined;
}

/**
 * Creates a deterministic temp file path for atomic writes (tmp+rename).
 * @param base - The final destination path
 * @param suffix - Appended after the UUID (default ".tmp")
 * @example createTempPath("/data/file.json") → "/data/file.json.<uuid>.tmp"
 * @example createTempPath("/data/file.json", ".source.tmp") → "/data/file.json.<uuid>.source.tmp"
 */
export const createTempPath = (base: string, suffix = ".tmp"): string =>
	`${base}.${crypto.randomUUID()}${suffix.startsWith(".") ? suffix : `.${suffix}`}`;

/**
 * Change-detection signature (size + floored mtime) for cache keys that must
 * invalidate when a file is replaced in place.
 */
export const fileStatSignature = (stats: { size: number; mtimeMs: number }): string => `${stats.size}:${Math.floor(stats.mtimeMs)}`;

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

async function readJsonFile<T>(path: string, options?: ReadJsonOptions | number): Promise<T | null>;

async function readJsonFile(path: string, options?: ReadJsonOptions | number): Promise<unknown> {
	try {
		const maxSize = typeof options === "number" ? options : options?.maxSize;
		if (maxSize !== undefined) {
			const stats = await stat(path).catch(() => null);
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

export const FileUtils = {
	async getStats(path: string) {
		try {
			return await stat(path);
		} catch {
			return null;
		}
	},

	async exists(path: string): Promise<boolean> {
		return await bunFile(path).exists();
	},

	/**
	 * Distinguishes a genuinely missing file from an unreadable one. `exists()`
	 * returns `false` for every error (EACCES/EBUSY/EIO/timeout), which made the
	 * scanner treat a transient NAS/ACL failure as "file deleted".
	 */
	async existence(path: string): Promise<"exists" | "missing" | "unavailable"> {
		try {
			await stat(path);

			return "exists";
		} catch (error) {
			const code = errorCode(error);

			return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
		}
	},

	readJson<T>(path: string, options?: ReadJsonOptions | number): Promise<T | null> {
		return readJsonFile<T>(path, options);
	},

	async write(path: string, content: string | object | Buffer | ArrayBuffer | Uint8Array): Promise<boolean> {
		try {
			const isBinary = Buffer.isBuffer(content) || content instanceof ArrayBuffer || content instanceof Uint8Array;
			const data = typeof content === "object" && !isBinary ? JSON.stringify(content, null, 2) : content;

			await bunWrite(path, data);

			return true;
		} catch (error) {
			logger.error("Write error", error, { filePath: path });

			return false;
		}
	},

	/**
	 * Atomic write (tmp+rename): the payload lands in a temp file beside `path`
	 * and is renamed into place only after a successful write, so a crash
	 * mid-write can never leave a truncated target. The temp file is always
	 * cleaned up — a failed write must not leave a `<path>.<uuid>.tmp` behind
	 * (the scanner would list it). Write/rename failures reject like Bun.write.
	 */
	async writeAtomic(
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
			await FileUtils.delete(temporaryPath);
		}
	},

	async delete(path: string): Promise<boolean> {
		if (PathUtils.isVideoFile(path)) {
			logger.warn("Refusing to delete video file", { filePath: path });

			return false;
		}

		try {
			await unlink(path);

			return true;
		} catch {
			return false;
		}
	},

	/**
	 * Downloads a URL to disk atomically: streams the response through a Bun
	 * `FileSink` into a temp file (capped at `maxBytes`, no full-file buffering),
	 * optionally validates it, then renames it into place. Merged from the old
	 * `NetworkUtils.download` — the naive `FileUtils.download`/`Bun.write(dest, response)`
	 * variant was dropped since it neither enforced a size cap nor validated content.
	 */
	async download(url: string, destination: string, options: DownloadOptions = {}): Promise<boolean> {
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
			if (!response.ok) throw new InternalError(`HTTP ${response.status}`, { code: "download.http_error" });

			if (options.allowedContentTypes?.length) {
				const contentType = normalizeContentType(response.headers.get("content-type"));
				const isAllowed = options.allowedContentTypes.some((prefix) => contentType.startsWith(prefix));
				if (!isAllowed)
					throw new InternalError(`Unexpected content type: ${contentType || "unknown"}`, { code: "download.invalid_content_type" });
			}

			const declaredSize = Number(response.headers.get("content-length"));
			if (isFiniteNumber(declaredSize) && declaredSize > maxBytes) {
				throw new ValidationError(`Download exceeds the ${maxBytes} byte limit`, { code: "download.exceeds_size_limit" });
			}

			if (!response.body) throw new InternalError("Response has no body", { code: "download.no_body" });

			await streamToFile(response.body, temporaryPath, maxBytes, effectiveSignal);
			if (options.validate) await options.validate(temporaryPath);

			await rename(temporaryPath, destination);

			return true;
		} catch (error) {
			options.onError?.(error);
			logger.error("Download error", error, { filePath: destination });
			await unlink(temporaryPath).catch(() => {
				// Temporary file already removed — nothing to clean.
			});

			return false;
		}
	},

	getSize(path: string): number {
		return bunFile(path).size;
	},

	get(path: string) {
		return bunFile(path);
	},
};

/** Streams a response body to disk via Bun's FileSink, enforcing a hard byte cap without buffering the whole file in memory. */
async function streamToFile(body: ReadableStream<Uint8Array>, path: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
	const sink = bunFile(path).writer();
	const reader = body.getReader();
	let receivedBytes = 0;

	try {
		for (;;) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;

			receivedBytes += value.byteLength;
			if (receivedBytes > maxBytes)
				throw new ValidationError(`Download exceeds the ${maxBytes} byte limit`, { code: "download.exceeds_size_limit" });

			await sink.write(value);
		}

		await sink.end();
	} catch (error) {
		try {
			await sink.end();
		} catch {
			// Sink already closed — nothing left to flush.
		}

		throw error;
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Reader already cancelled or stream already closed.
		}
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
