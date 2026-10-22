import { resolve } from "node:path";
import { DomainError } from "@/utils/domain.errors";
import { isSubpath } from "@/utils/path.utils";

export function unsafeEntryPath(entryPath: string): DomainError {
	return new DomainError("validation", `Plugin package contains an unsafe entry path: ${entryPath}`, {
		code: "plugin.package_path_unsafe",
		params: { path: entryPath },
	});
}

export function unpackedTooLarge(): DomainError {
	return new DomainError("validation", "Plugin package exceeds the uncompressed size limit", {
		code: "plugin.package_unpacked_too_large",
	});
}

/** A symlink entry the extractor refuses; `reason` completes the sentence "Plugin package contains <reason>: <name>". */
export function invalidSymlink(name: string, reason: string): DomainError {
	return new DomainError("validation", `Plugin package contains ${reason}: ${name}`, {
		code: "plugin.package_symlink_invalid",
		params: { path: name },
	});
}

/** Resolves an archive entry path under `workRoot`, refusing anything that could escape it. */
export function assertSafeDestination(workRoot: string, entryPath: string): string {
	const normalized = entryPath.replaceAll("\\", "/");
	// A NUL byte cannot name a file; refusing it here keeps the raw path error from surfacing as a server error.
	if (entryPath.includes("\0") || normalized.startsWith("/") || normalized.split("/").includes("..")) {
		throw unsafeEntryPath(entryPath);
	}

	const target = resolve(workRoot, normalized);
	if (target !== workRoot && !isSubpath(target, workRoot)) throw unsafeEntryPath(entryPath);

	return target;
}
