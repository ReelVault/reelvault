import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AdminFilesystemBrowse } from "@reelvault/sdk/common";
import { file as bunFile } from "bun";
import { systemResourcesService } from "@/config/system-resources.service";
import { mapConcurrent } from "@/utils/promise.utils";
import { isNonEmptyString } from "@/utils/type.utils";

type DirectoryEntry = AdminFilesystemBrowse["directories"][number];

function browseResult(currentPath: string, directories: DirectoryEntry[], exists: boolean): AdminFilesystemBrowse {
	return {
		currentPath,
		parentPath: currentPath === "/" ? null : dirname(currentPath),
		directories,
		exists,
	};
}

/** Subdirectories of `dir`, symlinked ones included when they resolve to a directory. Broken links are skipped. */
async function listSubdirectories(dir: string): Promise<DirectoryEntry[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const directories: DirectoryEntry[] = [];
	const symlinkNames: string[] = [];

	for (const entry of entries) {
		if (entry.isDirectory()) {
			directories.push({ name: entry.name, path: join(dir, entry.name) });
		} else if (entry.isSymbolicLink()) {
			symlinkNames.push(entry.name);
		}
	}

	await mapConcurrent(symlinkNames, systemResourcesService.getIoConcurrency(), async (name) => {
		try {
			if ((await bunFile(join(dir, name)).stat()).isDirectory()) {
				directories.push({ name, path: join(dir, name) });
			}
		} catch {
			// Ignore broken symlinks
		}
	});

	return directories.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Lists the subdirectories of a server path for the admin folder picker. `/` when no path is given. */
export async function browseFilesystem(requestedPath?: string): Promise<AdminFilesystemBrowse> {
	const targetPath = isNonEmptyString(requestedPath) ? resolve(requestedPath.trim()) : "/";

	try {
		if (!(await bunFile(targetPath).stat()).isDirectory()) return browseResult(targetPath, [], false);

		return browseResult(targetPath, await listSubdirectories(targetPath), true);
	} catch {
		return browseResult(targetPath, [], false);
	}
}
