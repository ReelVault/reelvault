import type { AdminLogFileInfo } from "@reelvault/sdk/common";
import { throwIfAborted } from "@/utils/cancellation.utils";
import type { getLogFileDownloadContent, listLogFiles } from "./files.service";
import type { WithoutState } from "./shared.types";

/**
 * Every log file (current, rotated and the debug log) in one zip for support
 * requests. Admin-triggered and rate-limited; reads are bounded by the log
 * directory's retention.
 */
export async function getLogBundle(
	signal: AbortSignal | undefined,
	listFiles: (...args: WithoutState<typeof listLogFiles>) => Promise<AdminLogFileInfo[]>,
	downloadFile: (...args: WithoutState<typeof getLogFileDownloadContent>) => ReturnType<typeof getLogFileDownloadContent>,
): Promise<{ data: Uint8Array<ArrayBuffer>; filename: string }> {
	const files = await listFiles();
	const entries: Record<string, Uint8Array> = {};
	for (const info of files) {
		throwIfAborted(signal);

		const { file } = await downloadFile(info.id);
		entries[info.name] = new Uint8Array(await file.arrayBuffer());
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	// Loaded on the first bundle download, not at boot.
	const { zipSync } = await import("fflate");
	const zipped = zipSync(entries, { level: 6 });

	// A fresh buffer keeps the view narrow (`Uint8Array<ArrayBuffer>`), which the Response body type requires.
	const data = new Uint8Array(zipped.byteLength);
	data.set(zipped);

	return { data, filename: `reelvault-logs-${timestamp}.zip` };
}
