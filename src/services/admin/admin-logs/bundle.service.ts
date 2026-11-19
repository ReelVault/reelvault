import { archiveTimestamp, LOG_ARCHIVE_MAX_BYTES, toOwnedBytes } from "@/services/admin/admin-files.utils";
import { MIB } from "@/utils/bytes.utils";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { getLogFileDownloadContent, listLogFiles } from "./files.service";

/**
 * Every log file (current, rotated and the debug log) in one zip for support
 * requests. Admin-triggered and rate-limited. The bundle is capped and the
 * request signal is observed, so a client disconnect stops the reads.
 */
export async function getLogBundle(signal?: AbortSignal): Promise<{ data: Uint8Array<ArrayBuffer>; filename: string }> {
	const files = await listLogFiles();
	const entries: Record<string, Uint8Array> = {};
	const omitted: string[] = [];
	let totalBytes = 0;

	for (const info of files) {
		throwIfAborted(signal);

		if (totalBytes + info.size > LOG_ARCHIVE_MAX_BYTES) {
			omitted.push(info.name);
			continue;
		}

		const { file } = await getLogFileDownloadContent(info.id);
		const bytes = new Uint8Array(await file.arrayBuffer());
		totalBytes += bytes.byteLength;
		entries[info.name] = bytes;
	}

	if (omitted.length > 0) {
		entries["omitted.txt"] = new TextEncoder().encode(
			`The bundle reached its ${LOG_ARCHIVE_MAX_BYTES / MIB} MB limit. Omitted files:\n${omitted.join("\n")}\n`,
		);
	}

	const timestamp = archiveTimestamp(new Date());
	// Loaded on the first bundle download, not at boot.
	const { zipSync } = await import("fflate");
	const data = toOwnedBytes(zipSync(entries, { level: 3 }));

	return { data, filename: `reelvault-logs-${timestamp}.zip` };
}
