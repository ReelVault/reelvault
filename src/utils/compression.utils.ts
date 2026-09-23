import { brotliCompress, constants, deflate, gzip } from "node:zlib";
import { serverConfig } from "@/server.config";

type CompressionEncoding = "br" | "gzip" | "deflate";

export function negotiateEncoding(acceptEncoding: string): CompressionEncoding | null {
	if (acceptEncoding.includes("br")) return "br";

	if (acceptEncoding.includes("gzip")) return "gzip";

	if (acceptEncoding.includes("deflate")) return "deflate";

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
