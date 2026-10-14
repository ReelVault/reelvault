import { brotliCompress, constants, deflate, gzip } from "node:zlib";
import { serverConfig } from "@/server.config";
import { MemoryCache } from "@/utils/memory-cache";

type CompressionEncoding = "br" | "gzip" | "deflate";
type NegotiatedEncoding = CompressionEncoding | "none";

/** Browsers repeat the same few Accept-Encoding values on every request, so a small LRU answers nearly all calls. */
const NEGOTIATION_MEMO_MAX_ENTRIES = 64;
/** Longer headers are parsed on every call instead of being kept as cache keys. */
const NEGOTIATION_MEMO_MAX_KEY_LENGTH = 256;

let negotiationMemo: MemoryCache<NegotiatedEncoding> | undefined;

/** Built on first use: a module-level instance could run before MemoryCache is evaluated when imports cycle. */
function getNegotiationMemo(): MemoryCache<NegotiatedEncoding> {
	negotiationMemo ??= new MemoryCache<NegotiatedEncoding>({ maxSize: NEGOTIATION_MEMO_MAX_ENTRIES, ttlMs: -1 });

	return negotiationMemo;
}

export function negotiateEncoding(acceptEncoding: string): CompressionEncoding | null {
	if (!acceptEncoding) return null;
	if (acceptEncoding.length > NEGOTIATION_MEMO_MAX_KEY_LENGTH) return parseAcceptEncoding(acceptEncoding);

	const memo = getNegotiationMemo();
	const memoized = memo.get(acceptEncoding);
	if (memoized !== null) return memoized === "none" ? null : memoized;

	const encoding = parseAcceptEncoding(acceptEncoding);
	memo.set(acceptEncoding, encoding ?? "none");

	return encoding;
}

function parseAcceptEncoding(acceptEncoding: string): CompressionEncoding | null {
	// Fast path for the common single-token header (no list, no q-values) —
	// avoids the Set + split allocation. Anything with `,`/`;` uses the parser.
	if (!(acceptEncoding.includes(",") || acceptEncoding.includes(";"))) {
		const token = acceptEncoding.trim().toLowerCase();
		if (token === "br") return "br";
		if (token === "gzip") return "gzip";
		if (token === "deflate") return "deflate";

		return null;
	}

	// Tokens with `q=0` are explicitly refused — substring matching used to pick
	// an encoding the client had disabled (and would match `x-gzip` too).
	const accepted = new Set<string>();
	for (const part of acceptEncoding.split(",")) {
		const [tokenPart, ...params] = part.trim().toLowerCase().split(";");
		const token = tokenPart?.trim() ?? "";
		if (!token) continue;

		const qParam = params.find((param) => param.trim().startsWith("q="));
		const quality = qParam ? Number.parseFloat(qParam.slice(qParam.indexOf("=") + 1)) : 1;
		if (Number.isFinite(quality) && quality > 0) accepted.add(token);
	}

	if (accepted.has("br")) return "br";

	if (accepted.has("gzip")) return "gzip";

	if (accepted.has("deflate")) return "deflate";

	return null;
}

export function compressBuffer(input: Buffer, encoding: CompressionEncoding): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const cb = (error: Error | null, result: Buffer) => (error ? reject(error) : resolve(result));
		if (encoding === "br") {
			brotliCompress(
				input,
				{
					params: {
						[constants.BROTLI_PARAM_QUALITY]: serverConfig.compression.brotliQuality,
						[constants.BROTLI_PARAM_LGWIN]: serverConfig.compression.brotliLgwin,
					},
				},
				cb,
			);

			return;
		}

		if (encoding === "gzip") {
			gzip(input, { level: serverConfig.compression.gzipLevel }, cb);

			return;
		}

		deflate(input, cb);
	});
}
