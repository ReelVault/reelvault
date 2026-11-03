import { DomainError, errorMessage } from "@/utils/domain.errors";
import { detach } from "@/utils/promise.utils";
import { extractArchive } from "./extract.extractor";
import type { PluginPackageExtractRequest, PluginPackageExtractResponse } from "./plugin-package-extract.types";

/** Worker-thread `postMessage`; `Reflect.apply` keeps the one-argument worker signature. */
function post(response: PluginPackageExtractResponse): void {
	Reflect.apply(globalThis.postMessage, globalThis, [response]);
}

async function handleExtraction(request: PluginPackageExtractRequest): Promise<void> {
	try {
		await extractArchive(request.archivePath, request.workRoot, request.maxUncompressedBytes);
		post({ ok: true });
	} catch (error) {
		if (error instanceof DomainError) {
			post({
				ok: false,
				category: error.category,
				code: error.code,
				message: error.message,
				params: error.params,
			});

			return;
		}

		post({
			ok: false,
			category: "internal",
			code: "plugin.archive_extract_failed",
			message: errorMessage(error),
		});
	}
}

/**
 * Extraction runs in a worker thread: zip/tar writers are synchronous and a
 * 512 MB package would otherwise freeze HTTP, WebSocket and playback work for
 * the whole install.
 */
globalThis.addEventListener("message", (event: MessageEvent<PluginPackageExtractRequest>) => {
	detach(handleExtraction(event.data));
});
