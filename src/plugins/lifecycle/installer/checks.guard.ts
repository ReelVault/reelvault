import { resolve } from "node:path";
import type { PluginManifest } from "@reelvault/sdk/plugin";
import { file as bunFile } from "bun";
import { systemResourcesService } from "@/config/system-resources.service";
import { loadPluginManifest, resolvePluginEntry } from "@/plugins/lifecycle/plugin.manifest";
import { DomainError } from "@/utils/domain.errors";
import { clamp } from "@/utils/math.utils";
import { isSubpath } from "@/utils/path.utils";
import { minServerVersionError } from "@/utils/semver.utils";
import { assertNoSymbolicLinks } from "./symlink.guard";

/** SHA-256 over large blobs — CPU+disk bound, so concurrency scales with measured capacity. */
export function verificationConcurrency() {
	return clamp(Math.ceil(systemResourcesService.getMetrics().capacity / 2), 1, 8);
}

/** A package directory must exist and contain no symbolic links. */
export async function assertPackageDirectory(directory: string): Promise<void> {
	await assertDirectory(directory);
	await assertNoSymbolicLinks(directory, verificationConcurrency());
}

/** Loads the source manifest and refuses a package that needs a newer server or lacks its entry file. */
export async function loadInstallableManifest(source: string): Promise<PluginManifest> {
	const manifest = await loadPluginManifest(source);
	const versionError = minServerVersionError(
		manifest.minServerVersion,
		`Plugin ${manifest.id} ${manifest.version}`,
		"plugin.server_too_old",
	);
	if (versionError) throw versionError;
	await assertFile(resolvePluginEntry(source, manifest), "Plugin entrypoint");

	return manifest;
}

export function assertSeparateDirectories(source: string, pluginsDirectory: string): void {
	if (isWithinDirectory(source, pluginsDirectory) || isWithinDirectory(pluginsDirectory, source)) {
		throw new DomainError("validation", "Plugin source directory must not overlap with the destination plugins directory", {
			code: "plugin.source_overlaps_plugins_directory",
		});
	}
}

async function assertDirectory(directory: string): Promise<void> {
	const source = await bunFile(directory)
		.stat()
		.catch(() => {
			// intentionally empty
		});
	if (!source?.isDirectory())
		throw new DomainError("validation", `Plugin source directory does not exist: ${directory}`, { code: "plugin.source_missing" });
}

async function assertFile(path: string, name: string): Promise<void> {
	const metadata = await bunFile(path)
		.stat()
		.catch(() => {
			// intentionally empty
		});
	if (!metadata?.isFile()) throw new DomainError("validation", `${name} does not exist: ${path}`, { code: "plugin.entry_missing" });
}

function isWithinDirectory(path: string, directory: string): boolean {
	return resolve(path) === resolve(directory) || isSubpath(path, directory);
}
