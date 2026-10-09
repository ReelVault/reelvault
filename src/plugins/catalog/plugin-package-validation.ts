import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PluginValidationIssue, PluginValidationResult } from "@reelvault/sdk/common";
import { installDirection } from "@/plugins/lifecycle/plugin.installer";
import { loadPluginManifest, resolvePluginEntry, validatePluginUiManifest } from "@/plugins/lifecycle/plugin.manifest";
import { errorMessage } from "@/utils/errors";
import { isNewerVersion } from "@/utils/semver.utils";
import { SERVER_VERSION } from "@/version";

export interface InstalledVersion {
	id: string;
	version: string;
}

function issue(severity: PluginValidationIssue["severity"], code: string, message: string): PluginValidationIssue {
	return { severity, code, message };
}

/** Result for an archive that could not be unpacked at all. */
export function archiveValidationFailure(error: unknown): PluginValidationResult {
	return { valid: false, issues: [issue("error", "plugin.archive_invalid", errorMessage(error))] };
}

async function isFile(path: string): Promise<boolean> {
	return await stat(path).then(
		(metadata) => metadata.isFile(),
		() => false,
	);
}

/**
 * Dry run of an unpacked plugin package: the checks an install and the first load
 * would make, without touching the installed plugins. An `error` blocks the install;
 * a `warning` is reported and does not.
 */
export async function validatePluginPackage(pluginRoot: string, installed: readonly InstalledVersion[]): Promise<PluginValidationResult> {
	let manifest: Awaited<ReturnType<typeof loadPluginManifest>>;
	try {
		manifest = await loadPluginManifest(pluginRoot);
	} catch (error) {
		return { valid: false, issues: [issue("error", "plugin.manifest_invalid", errorMessage(error))] };
	}

	const issues: PluginValidationIssue[] = [];
	if (manifest.minServerVersion && isNewerVersion(manifest.minServerVersion, SERVER_VERSION)) {
		issues.push(
			issue("error", "plugin.server_too_old", `requires server ${manifest.minServerVersion} or newer (running ${SERVER_VERSION})`),
		);
	}

	if (!(await isFile(resolvePluginEntry(pluginRoot, manifest)))) {
		issues.push(issue("error", "plugin.entry_missing", `entry ${manifest.entry} does not exist`));
	}

	// The loader keeps a plugin whose interface manifest is malformed and skips only the interface, so this is a warning.
	const uiManifestPath = join(pluginRoot, "ui.json");
	if (await isFile(uiManifestPath)) {
		try {
			validatePluginUiManifest(JSON.parse(await Bun.file(uiManifestPath).text()));
		} catch (error) {
			issues.push(issue("warning", "plugin.ui_manifest_invalid", errorMessage(error)));
		}
	}

	const installedVersion = installed.find((entry) => entry.id === manifest.id)?.version;
	const direction = installDirection(installedVersion, manifest.version);
	if (direction === "downgrade") {
		issues.push(
			issue(
				"warning",
				"plugin.version_downgrade",
				`version ${installedVersion ?? "unknown"} is installed; this package is ${manifest.version}`,
			),
		);
	}

	return {
		valid: !issues.some((item) => item.severity === "error"),
		pluginId: manifest.id,
		version: manifest.version,
		...(installedVersion ? { installedVersion } : {}),
		direction,
		issues,
	};
}
