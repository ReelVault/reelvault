import { PathUtils } from "@/utils/path.utils";
import type { InstalledPluginRecord, PluginPreviousInstall } from "./lockfile.store";

/** The admin's own choices on a plugin. They survive an upgrade's rollback point and its restore. */
type AdminChoices = Pick<InstalledPluginRecord, "disabled" | "cspDisabled" | "pinned">;

function adminChoicesOf(source: AdminChoices): AdminChoices {
	return {
		...(source.disabled === undefined ? {} : { disabled: source.disabled }),
		...(source.cspDisabled === undefined ? {} : { cspDisabled: source.cspDisabled }),
		...(source.pinned === undefined ? {} : { pinned: source.pinned }),
	};
}

interface InstallRecordInput {
	targetDirectory: string;
	version: string;
	integrity: string;
	source: string;
	previousRecord: InstalledPluginRecord | undefined;
	backupDirectory: string | undefined;
}

/** Lockfile record for a freshly staged package. An upgrade keeps the admin's CSP and pin choices and its rollback point. */
export function buildInstallRecord(input: InstallRecordInput): InstalledPluginRecord {
	const { targetDirectory, version, integrity, source, previousRecord, backupDirectory } = input;

	return {
		directory: PathUtils.getFileName(targetDirectory),
		integrity,
		installedAt: new Date().toISOString(),
		source,
		// The admin's CSP choice follows the plugin across an upgrade.
		...(previousRecord?.cspDisabled === undefined ? {} : { cspDisabled: previousRecord.cspDisabled }),
		...(previousRecord?.pinned === undefined ? {} : { pinned: previousRecord.pinned }),
		version,
		...(previousRecord && backupDirectory ? { previous: toPreviousInstall(previousRecord, backupDirectory) } : {}),
	};
}

/** The record a rollback restores: the package the upgrade replaced, with the admin's choices as they were then. */
export function restoredRecord(previous: PluginPreviousInstall, directory: string): InstalledPluginRecord {
	return {
		directory,
		integrity: previous.integrity,
		installedAt: previous.installedAt,
		source: previous.source,
		version: previous.version,
		...adminChoicesOf(previous),
	};
}

function toPreviousInstall(record: InstalledPluginRecord, backupDirectory: string): PluginPreviousInstall {
	return {
		version: record.version,
		integrity: record.integrity,
		installedAt: record.installedAt,
		source: record.source,
		...adminChoicesOf(record),
		backupDirectory: PathUtils.getFileName(backupDirectory),
	};
}
