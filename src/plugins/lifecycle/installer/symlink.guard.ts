import { lstat, readdir } from "node:fs/promises";
import { DomainError } from "@/utils/domain.errors";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";

/** Rejects any package tree that contains a symbolic link at any depth. */
export async function assertNoSymbolicLinks(directory: string, concurrency: number): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	await PromiseUtils.mapConcurrent(entries, concurrency, async (entry) => {
		const path = PathUtils.join(directory, entry.name);
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink())
			throw new DomainError("validation", `Plugin package must not contain symbolic links: ${path}`, {
				code: "plugin.package_symlink_invalid",
				params: { path },
			});

		if (metadata.isDirectory()) await assertNoSymbolicLinks(path, concurrency);
	});
}
