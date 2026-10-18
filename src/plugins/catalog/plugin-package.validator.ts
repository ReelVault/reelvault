import { join } from "node:path";
import type { PluginValidationIssue, PluginValidationResult } from "@reelvault/sdk/common";
import { file as bunFile } from "bun";
import { SERVER_VERSION } from "@/config/version.constants";
import { validatePluginUiManifest } from "@/plugins/lifecycle/manifest/ui.validator";
import { installDirection } from "@/plugins/lifecycle/plugin.installer";
import { loadPluginManifest, resolvePluginEntry } from "@/plugins/lifecycle/plugin.manifest";
import { DomainError, definedParams, errorMessage } from "@/utils/domain.errors";
import { isNewerVersion } from "@/utils/semver.utils";

export interface InstalledVersion {
	id: string;
	version: string;
}

function issue(
	severity: PluginValidationIssue["severity"],
	code: string,
	message: string,
	params?: PluginValidationIssue["params"],
): PluginValidationIssue {
	return { severity, code, message, ...(params ? { params } : {}) };
}

/**
 * A domain error keeps its own code and params, so the report can be translated
 * field by field; any other failure is reported under the fallback code.
 */
function issueFromError(severity: PluginValidationIssue["severity"], error: unknown, fallbackCode: string): PluginValidationIssue {
	if (error instanceof DomainError) return issue(severity, error.code, error.message, definedParams(error.params));

	return issue(severity, fallbackCode, errorMessage(error));
}

/** Result for an archive that could not be unpacked at all. */
export function archiveValidationFailure(error: unknown): PluginValidationResult {
	return { valid: false, issues: [issueFromError("error", error, "plugin.archive_invalid")] };
}

async function isFile(path: string): Promise<boolean> {
	return await bunFile(path)
		.stat()
		.then(
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
		return { valid: false, issues: [issueFromError("error", error, "plugin.manifest_invalid")] };
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
			issues.push(issueFromError("warning", error, "plugin.ui_manifest_invalid"));
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
				{ installed: installedVersion ?? "unknown", version: manifest.version },
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
