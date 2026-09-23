import { describe, expect, test } from "bun:test";
import { serverConfig } from "@/server.config";
import { assertPluginBlobWrite } from "./plugin.blobs.validation";

describe("plugin blob storage", () => {
	test("accepts a bounded blob with explicit retention", () => {
		expect(() =>
			assertPluginBlobWrite(new Uint8Array([1]), { contentType: "application/octet-stream", expiresInMs: 60_000 }),
		).not.toThrow();
	});

	test("rejects unbounded retention, invalid content type, and an oversized blob", () => {
		expect(() => assertPluginBlobWrite(new Uint8Array([1]), { contentType: "", expiresInMs: 1 })).toThrow("content type");
		expect(() =>
			assertPluginBlobWrite(new Uint8Array([1]), {
				contentType: "application/octet-stream",
				expiresInMs: serverConfig.plugins.blobs.retentionMs + 1,
			}),
		).toThrow("retention");
		expect(() =>
			assertPluginBlobWrite(new Uint8Array(serverConfig.plugins.blobs.maxBlobBytes + 1), {
				contentType: "application/octet-stream",
				expiresInMs: 1,
			}),
		).toThrow("blob");
	});
});
