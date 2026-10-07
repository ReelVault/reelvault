import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "@/utils/errors";
import {
	componentMarkerName,
	DISCARD_DIR,
	LAUNCHER_FILE_NAMES,
	PREVIOUS_DIR,
	SERVER_DIR_NAMES,
	type UpdateComponent,
	WEB_DIR_NAMES,
} from "./update-environment";

/**
 * File and directory names an update of the given component moves aside and
 * replaces. The server set also owns `bin/` (bundled ffmpeg) — a server
 * archive never carries one, so an existing `bin/` stays live across updates.
 */
function componentNames(component: UpdateComponent): readonly string[] {
	return component === "server" ? [...SERVER_DIR_NAMES, ...LAUNCHER_FILE_NAMES] : WEB_DIR_NAMES;
}

/**
 * Moves the live files of `component` into `.previous/` and moves the
 * extracted release into their place. Atomic renames on the same volume —
 * safe while the server is running. `data/` and `settings.env` are never
 * touched.
 */
export function swapIntoPlace(root: string, stagedDir: string, component: UpdateComponent, replacedVersion: string): void {
	const previous = join(root, PREVIOUS_DIR);
	mkdirSync(previous, { recursive: true });

	for (const name of componentNames(component)) {
		const source = join(root, name);
		if (!existsSync(source)) continue;
		if (name === "bin" && !existsSync(join(stagedDir, name))) continue;

		// A new update supersedes the previous rollback point: clear the destination
		// first, otherwise POSIX rename fails with ENOTEMPTY once `.previous/<name>`
		// exists from an earlier update (the Windows swap script clears it wholesale).
		rmSync(join(previous, name), { recursive: true, force: true });
		renameSync(source, join(previous, name));
	}
	writeFileSync(join(previous, componentMarkerName(component)), replacedVersion);

	for (const name of componentNames(component)) {
		const source = join(stagedDir, name);
		if (existsSync(source)) renameSync(source, join(root, name));
	}
}

/**
 * Swaps the extracted web dist in directly: the zip root IS the new `web/`.
 * The old directory moves to `.previous/web` for a component rollback.
 */
export function swapWebDirectory(root: string, extractedDir: string, replacedVersion: string): void {
	const previous = join(root, PREVIOUS_DIR);
	mkdirSync(previous, { recursive: true });

	const current = join(root, "web");
	if (existsSync(current)) {
		// Same as the server swap: the latest update owns the rollback slot.
		rmSync(join(previous, "web"), { recursive: true, force: true });
		renameSync(current, join(previous, "web"));
	}
	writeFileSync(join(previous, componentMarkerName("web")), replacedVersion);

	try {
		renameSync(extractedDir, current);
	} catch (error) {
		const backup = join(previous, "web");
		if (existsSync(backup)) renameSync(backup, current);
		throw error;
	}
}

/** Restores the `.previous/` set of `component`; the displaced version goes to `.update-discard/`. */
export function swapBackFromPrevious(root: string, component: UpdateComponent): string {
	const previous = join(root, PREVIOUS_DIR);
	const restoredVersion = readPreviousVersion(root, component);
	const discard = join(root, DISCARD_DIR);
	mkdirSync(discard, { recursive: true });

	for (const name of componentNames(component)) {
		const current = join(root, name);
		if (existsSync(current)) renameSync(current, join(discard, name));

		const backup = join(previous, name);
		if (existsSync(backup)) renameSync(backup, join(root, name));
	}
	rmSync(join(previous, componentMarkerName(component)), { force: true });
	// The other component's marker may still be pending, so the directory
	// itself survives until both components have been restored.
	if (!(existsSync(join(previous, componentMarkerName("server"))) || existsSync(join(previous, componentMarkerName("web"))))) {
		rmSync(previous, { recursive: true, force: true });
	}

	return restoredVersion;
}

export function readPreviousVersion(root: string, component: UpdateComponent): string {
	const marker = join(root, PREVIOUS_DIR, componentMarkerName(component));
	if (!existsSync(marker)) {
		throw new ValidationError(`No previous ${component} version is available to roll back to`, { code: "update.no_previous_version" });
	}

	return readFileSync(marker, "utf8").trim() || "";
}
