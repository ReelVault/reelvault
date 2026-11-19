import { MIB } from "@/utils/bytes.utils";
import { resolveWithin } from "@/utils/path.utils";

/** Ceiling for one log archive (support bundle or session log): archives are read into memory. */
export const LOG_ARCHIVE_MAX_BYTES = 64 * MIB;

/** The path of `name` under `root`; undefined when the name climbs with `..` or the result leaves `root`. */
export function resolveConfinedPath(root: string, name: string): string | undefined {
	if (name.includes("..")) return undefined;

	return resolveWithin(root, name);
}

/** The ISO time as a file-name segment: `:` and `.` become `-`. */
export function archiveTimestamp(now: Date): string {
	return now.toISOString().replaceAll(/[:.]/g, "-");
}

/** A copy in a fresh buffer: the Response body type needs the narrow `Uint8Array<ArrayBuffer>` view. */
export function toOwnedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);

	return copy;
}
