import type { PluginBlobWriteOptions } from "@sdk/plugin";
import { contentByteSize } from "@/plugins/shared/plugin.file-record.utils";
import { serverConfig } from "@/server.config";
import { ValidationError } from "@/utils/errors";

export function assertPluginBlobWrite(content: Blob | Uint8Array, options: PluginBlobWriteOptions): void {
	if (contentByteSize(content) > serverConfig.plugins.blobs.maxBlobBytes) {
		throw new ValidationError(`Plugin blob must not exceed ${serverConfig.plugins.blobs.maxBlobBytes} bytes`, {
			code: "plugin.blob.too_large",
		});
	}

	if (!options.contentType.trim() || options.contentType.length > serverConfig.plugins.blobs.maxContentTypeLength) {
		throw new ValidationError(
			`Plugin blob content type must be between 1 and ${serverConfig.plugins.blobs.maxContentTypeLength} characters`,
			{ code: "plugin.blob.invalid_content_type" },
		);
	}

	if (!Number.isInteger(options.expiresInMs) || options.expiresInMs <= 0 || options.expiresInMs > serverConfig.plugins.blobs.retentionMs) {
		throw new ValidationError(`Plugin blob retention must be between 1 and ${serverConfig.plugins.blobs.retentionMs} milliseconds`, {
			code: "plugin.blob.invalid_retention",
		});
	}
}
