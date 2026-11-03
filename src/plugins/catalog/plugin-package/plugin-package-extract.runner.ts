import { DomainError } from "@/utils/domain.errors";
import type { PluginPackageExtractRequest, PluginPackageExtractResponse } from "./plugin-package-extract.types";

/** A package extraction that never finishes must not pin the install request forever. */
const EXTRACT_WORKER_TIMEOUT_MS = 15 * 60_000;

/**
 * Runs the synchronous archive writer on a worker thread and recreates the
 * original domain error in the parent, so callers keep the same codes.
 * Update archives are larger than plugin packages, so callers may pass a
 * longer deadline.
 */
export async function extractArchiveInWorker(
	archivePath: string,
	workRoot: string,
	maxUncompressedBytes: number,
	timeoutMs = EXTRACT_WORKER_TIMEOUT_MS,
): Promise<void> {
	const worker = new Worker(new URL("./plugin-package-extract.worker.ts", import.meta.url).href, {
		name: "plugin-package-extract",
	});

	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timeout: { handle?: ReturnType<typeof setTimeout> } = {};
			const finish = (complete: () => void): void => {
				if (settled) return;

				settled = true;
				if (timeout.handle) clearTimeout(timeout.handle);
				worker.terminate();
				complete();
			};

			timeout.handle = setTimeout(() => {
				finish(() =>
					reject(
						new DomainError("timeout", "Archive extraction exceeded its deadline", {
							code: "plugin.archive_extract_timeout",
						}),
					),
				);
			}, timeoutMs);

			worker.addEventListener("message", (event: MessageEvent<PluginPackageExtractResponse>) => {
				const response = event.data;
				if (response.ok) {
					finish(resolve);

					return;
				}

				finish(() =>
					reject(
						new DomainError(response.category, response.message, {
							code: response.code,
							params: response.params,
						}),
					),
				);
			});

			worker.addEventListener("error", (event: ErrorEvent) => {
				finish(() =>
					reject(
						new DomainError("internal", event.message || "Plugin package extraction worker failed", {
							code: "plugin.archive_extract_failed",
						}),
					),
				);
			});

			const request: PluginPackageExtractRequest = { archivePath, workRoot, maxUncompressedBytes };
			const post = worker.postMessage.bind(worker);
			post(request);
		});
	} finally {
		worker.terminate();
	}
}
