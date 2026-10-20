import { join, resolve } from "node:path";
import { systemResourcesService } from "@/config/system-resources.service";
import { listDirectoryEntries } from "@/utils/directory.utils";
import { mapConcurrent } from "@/utils/promise.utils";
import { toIgnoredAsset } from "./local-artwork.selector";
import type { IgnoredLocalAsset } from "./local-media.utils";

/** Bounds so a pathological tree cannot exhaust memory or hang the request. */
const MAX_DEPTH = 10;
const MAX_ENTRIES = 50_000;

export async function findIgnoredLocalAssets(root: string, options?: { signal?: AbortSignal }): Promise<IgnoredLocalAsset[]> {
	const resolvedRoot = resolve(root);
	const counter = { entries: 0 };

	return await visit(resolvedRoot, 0, counter, options?.signal);
}

async function visit(directory: string, depth: number, counter: { entries: number }, signal?: AbortSignal): Promise<IgnoredLocalAsset[]> {
	if (signal?.aborted || depth > MAX_DEPTH || counter.entries >= MAX_ENTRIES) return [];

	const entries = (await listDirectoryEntries(directory)) ?? [];
	const directories: string[] = [];
	const local: IgnoredLocalAsset[] = [];

	for (const entry of entries) {
		if (counter.entries >= MAX_ENTRIES) break;

		counter.entries++;
		const path = join(directory, entry.name);
		if (entry.isDirectory) {
			// Skip hidden/system dirs (.git, caches) — they never hold sidecars.
			if (!entry.name.startsWith(".")) directories.push(path);
		} else if (entry.isFile) {
			local.push(...toIgnoredAsset(path));
		}
	}

	const nested = await mapConcurrent(
		directories,
		systemResourcesService.getIoConcurrency(),
		async (dir) => await visit(dir, depth + 1, counter, signal),
		signal,
	);

	return [...local, ...nested.flat()];
}
