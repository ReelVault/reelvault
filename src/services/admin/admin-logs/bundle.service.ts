import { throwIfAborted } from "@/utils/cancellation.utils";
import { getLogFileDownloadContent, listLogFiles } from "./files.service";

/**
 * Every log file (current, rotated and the debug log) in one zip for support
 * requests. Admin-triggered and rate-limited; reads are bounded by the log
 * directory's retention.
 */
export async function getLogBundle(signal?: AbortSignal): Promise<{ data: Uint8Array<ArrayBuffer>; filename: string }> {
	const files = await listLogFiles();
	const entries: Record<string, Uint8Array> = {};
	for (const info of files) {
		throwIfAborted(signal);

		const { file } = await getLogFileDownloadContent(info.id);
		entries[info.name] = new Uint8Array(await file.arrayBuffer());
	}

	const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	// Loaded on the first bundle download, not at boot.
	const { zipSync } = await import("fflate");
	const zipped = zipSync(entries, { level: 6 });

	// A fresh buffer keeps the view narrow (`Uint8Array<ArrayBuffer>`), which the Response body type requires.
	const data = new Uint8Array(zipped.byteLength);
	data.set(zipped);

	return { data, filename: `reelvault-logs-${timestamp}.zip` };
}
