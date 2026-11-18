/** Shared source-file walking and offset→line helpers for the lint/mutation scripts. */

import { readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Explicit filters for the recursive TypeScript-file collectors. */
export interface CollectTypeScriptOptions {
	/** Extensions to include, with the leading dot. Defaults to `.ts` and `.tsx`. */
	extensions?: readonly string[] | undefined;
	/** Suffixes to exclude, e.g. `.test.ts` or `.d.ts`. Defaults to none. */
	excludeSuffixes?: readonly string[] | undefined;
	/** Exact file names to skip. Defaults to none. */
	skipFiles?: ReadonlySet<string> | undefined;
	/** Directory names to skip. Defaults to none. */
	skipDirectories?: ReadonlySet<string> | undefined;
}

function includesFile(name: string, options: CollectTypeScriptOptions): boolean {
	if (!(options.extensions ?? [".ts", ".tsx"]).some((extension) => name.endsWith(extension))) return false;
	if ((options.excludeSuffixes ?? []).some((suffix) => name.endsWith(suffix))) return false;

	return !(options.skipFiles?.has(name) ?? false);
}

/** Every matching file below `directory`, recursively, as paths rooted at `directory`. */
export async function collectTypeScriptFiles(directory: string, options: CollectTypeScriptOptions = {}): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (options.skipDirectories?.has(entry.name)) continue;
			files.push(...(await collectTypeScriptFiles(path, options)));
			continue;
		}
		if (entry.isFile() && includesFile(entry.name, options)) files.push(path);
	}

	return files;
}

/** The synchronous counterpart, for scripts that collect at module scope. */
export function collectTypeScriptFilesSync(directory: string, options: CollectTypeScriptOptions = {}): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		if (options.skipDirectories?.has(entry)) continue;
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) files.push(...collectTypeScriptFilesSync(path, options));
		else if (includesFile(entry, options)) files.push(path);
	}

	return files;
}

/** Byte offsets where each line starts, with line 1 at index 0. */
export function lineStartsOf(source: string): number[] {
	const starts = [0];
	let newline = source.indexOf("\n");
	while (newline !== -1) {
		starts.push(newline + 1);
		newline = source.indexOf("\n", newline + 1);
	}

	return starts;
}

/** Zero-based line index of `offset`, by binary search over the line starts. */
export function lineIndexOf(lineStarts: readonly number[], offset: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if ((lineStarts[middle] ?? 0) <= offset) low = middle;
		else high = middle - 1;
	}

	return low;
}
