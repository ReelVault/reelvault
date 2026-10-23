import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIB } from "@/utils/bytes.utils";
import { createHash } from "@/utils/crypto.utils";
import { removeTree } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { consumeStreamBounded } from "@/utils/file.utils";
import { guardedFetch } from "@/utils/url-guard.utils";

const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * MIB;
const DEFAULT_TIMEOUT_MS = 60_000;

interface DownloadedArchive {
	/** Directory holding the download — remove with `cleanup()` once consumed. */
	directory: string;
	filePath: string;
	checksum: string;
	size: number;
	cleanup(): Promise<void>;
}

interface DownloadArchiveOptions {
	/** Sent as `Authorization: Bearer <token>` for private repositories. */
	token?: string | undefined;
	timeoutMs?: number | undefined;
	maxBytes?: number | undefined;
	/** Aborts the download early (an administrator cancelling an update); combined with the timeout. */
	signal?: AbortSignal | undefined;
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
	const response = await requestArchive(url, options);
	if (!response.body)
		throw new DomainError("validation", "Plugin package download returned an empty body", { code: "plugin.download_empty" });

	const declaredLength = Number(response.headers.get("content-length") ?? 0);
	if (declaredLength > maxBytes) throw packageTooLarge(maxBytes);

	return storeArchive(response.body, { maxBytes, declaredLength, onProgress: options.onProgress });
}

/** Fetches through the SSRF guard; transport failures and non-2xx responses both fail the download. */
async function requestArchive(url: string, options: DownloadArchiveOptions): Promise<Response> {
	const token = options.token;
	const fetcher = options.fetcher ?? guardedFetch;
	let response: Response;
	try {
		// A catalog manifest's downloadUrl is remote-controlled — every hop must be
		// a public https address, not loopback/RFC1918/cloud-metadata.
		const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		response = await fetcher(url, {
			...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
			signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : "unknown error";
		throw new DomainError("validation", `Failed to download plugin package: ${reason}`, { cause: error, code: "plugin.download_failed" });
	}

	if (!response.ok)
		throw new DomainError("validation", `Plugin package download failed with HTTP ${response.status}`, {
			code: "plugin.download_failed_http",
			params: { status: response.status },
		});

	return response;
}

interface StoreOptions {
	maxBytes: number;
	declaredLength: number;
	onProgress?: DownloadArchiveOptions["onProgress"];
}

/** Writes the body to a fresh temporary directory, hashing it and counting the bytes actually received. */
async function storeArchive(
	body: ReadableStream<Uint8Array>,
	{ maxBytes, declaredLength, onProgress }: StoreOptions,
): Promise<DownloadedArchive> {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-plugin-pkg-"));
	const filePath = join(directory, "package.bin");
	const hasher = createHash("sha256");
	const writer = Bun.file(filePath).writer();
	let received = 0;
	try {
		// awaits: sequential — the writer is closed only after the body has been written in full
		received = await consumeStreamBounded(body, {
			maxBytes,
			overflow: () => packageTooLarge(maxBytes),
			onChunk: async (chunk, total) => {
				hasher.update(chunk);
				await writer.write(chunk);
				onProgress?.(total, declaredLength);
			},
		});

		await writer.end();
	} catch (error) {
		try {
			await writer.end();
		} catch {
			// intentionally empty — the sink may already be closed
		}

		await removeTree(directory);
		throw error;
	}

	return {
		directory,
		filePath,
		checksum: `sha256-${hasher.digest("hex")}`,
		size: received,
		cleanup: () => removeTree(directory),
	};
}

function packageTooLarge(maxBytes: number): DomainError {
	return new DomainError("validation", `Plugin package exceeds the ${maxBytes} byte limit`, {
		code: "plugin.package_too_large",
		params: { maxBytes },
	});
}
