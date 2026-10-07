import { describe, expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { compressBuffer, negotiateEncoding } from "./compression.utils";

describe("negotiateEncoding", () => {
	test("prefers brotli regardless of header order", () => {
		expect(negotiateEncoding("br, gzip")).toBe("br");
		expect(negotiateEncoding("gzip, br")).toBe("br");
	});

	test("falls back through gzip then deflate", () => {
		expect(negotiateEncoding("gzip")).toBe("gzip");
		expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
		expect(negotiateEncoding("deflate")).toBe("deflate");
	});

	test("returns null for no known encoding", () => {
		expect(negotiateEncoding("zstd")).toBe(null);
		expect(negotiateEncoding("")).toBe(null);
		expect(negotiateEncoding("identity")).toBe(null);
	});

	test("honours q=0 refusals and only matches exact tokens", () => {
		expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
		expect(negotiateEncoding("gzip;q=0")).toBe(null);
		expect(negotiateEncoding("br; q=0, gzip; q=0.5")).toBe("gzip");
		expect(negotiateEncoding("x-gzip")).toBe(null);
	});
});

describe("compressBuffer", () => {
	const payload = Buffer.from("reelvault compression round trip".repeat(20), "utf8");

	test("brotli output decompresses to the original payload", async () => {
		const compressed = await compressBuffer(payload, "br");
		expect(brotliDecompressSync(compressed).equals(payload)).toBe(true);
	});

	test("gzip output decompresses to the original payload", async () => {
		const compressed = await compressBuffer(payload, "gzip");
		expect(gunzipSync(compressed).equals(payload)).toBe(true);
	});

	test("deflate output decompresses to the original payload", async () => {
		const compressed = await compressBuffer(payload, "deflate");
		expect(inflateSync(compressed).equals(payload)).toBe(true);
	});
});
