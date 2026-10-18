import { describe, expect, test } from "bun:test";
import { serverConfig } from "@/config/server/server.config";
import { assertPluginBlobWrite } from "./plugin.blobs.validator";

describe("plugin blob storage", () => {
	test("refuses a blob without a content type", () => {
		expect(() => assertPluginBlobWrite(new Uint8Array([1]), { contentType: "", expiresInMs: 1 })).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.blob.invalid_content_type" }),
		);
	});

	test("refuses a retention longer than the configured maximum", () => {
		expect(() =>
			assertPluginBlobWrite(new Uint8Array([1]), {
				contentType: "application/octet-stream",
				expiresInMs: serverConfig.plugins.blobs.retentionMs + 1,
			}),
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.blob.invalid_retention" }));
	});

	test("refuses a blob larger than the configured maximum", () => {
		expect(() =>
			assertPluginBlobWrite(new Uint8Array(serverConfig.plugins.blobs.maxBlobBytes + 1), {
				contentType: "application/octet-stream",
				expiresInMs: 1,
			}),
		).toThrow(expect.objectContaining({ category: "validation", code: "plugin.blob.too_large" }));
	});
});
