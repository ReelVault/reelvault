import { MIB } from "@/utils/bytes.utils";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { getLogFileDownloadContent, listLogFiles } from "./files.service";

/** Hard ceiling for one support bundle: logs can grow to hundreds of MB and are read into memory. */
const MAX_BUNDLE_BYTES = 64 * MIB;

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

		if (totalBytes + info.size > MAX_BUNDLE_BYTES) {
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
			`The bundle reached its ${MAX_BUNDLE_BYTES / MIB} MB limit. Omitted files:\n${omitted.join("\n")}\n`,
		);
	}

	const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	// Loaded on the first bundle download, not at boot.
	const { zipSync } = await import("fflate");
	const zipped = zipSync(entries, { level: 3 });

	// A fresh buffer keeps the view narrow (`Uint8Array<ArrayBuffer>`), which the Response body type requires.
	const data = new Uint8Array(zipped.byteLength);
	data.set(zipped);

	return { data, filename: `reelvault-logs-${timestamp}.zip` };
}
