import { DomainError, isMissingFile } from "@/utils/errors";
import { FileUtils, readFile } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { isNonEmptyString, isRecord } from "@/utils/type.utils";

export const LOCKFILE_NAME = "plugins.lock.json";
const LOCKFILE_VERSION = 1;

export interface InstalledPluginRecord {
	directory: string;
	integrity: string;
	installedAt: string;
	source: string;
	version: string;
	/** Persisted across restarts — a disabled plugin stays unloaded until explicitly enabled. */
	disabled?: boolean;
	/** Admin choice: the CSP sources the manifest declares are refused. Persisted across restarts and upgrades. */
	cspDisabled?: boolean;
	/** Admin choice: the installed version is kept, so catalog updates are not offered. */
	pinned?: boolean;
	/** Set by an upgrade until the new version has loaded once; a failed load rolls back to it. */
	previous?: PluginPreviousInstall;
}

/** The package an upgrade replaced. It stays on disk until the new version has loaded, then it is removed. */
export interface PluginPreviousInstall {
	version: string;
	integrity: string;
	installedAt: string;
	source: string;
	disabled?: boolean;
	cspDisabled?: boolean;
	pinned?: boolean;
	/** Basename of the directory the previous package was moved to, inside the plugins root. */
	backupDirectory: string;
}

export interface PluginLockfile {
	version: number;
	plugins: Record<string, InstalledPluginRecord>;
}

/** Owns read/write access to `plugins.lock.json` and validates its directory entries. */
export class PluginLockfileStore {
	private readonly pluginsDirectory: string;

	constructor(pluginsDirectory: string) {
		this.pluginsDirectory = pluginsDirectory;
	}

	async read(): Promise<PluginLockfile> {
		const lockfilePath = this.lockfilePath();
		try {
			const parsed: unknown = JSON.parse(await readFile(lockfilePath, "utf8"));
			if (!isPluginLockfile(parsed)) throw new DomainError("validation", `Invalid ${LOCKFILE_NAME}`, { code: "plugin.lockfile_invalid" });

			return parsed;
		} catch (error) {
			if (isMissingFile(error)) return { version: LOCKFILE_VERSION, plugins: {} };

			throw error;
		}
	}

	async write(lockfile: PluginLockfile): Promise<void> {
		await FileUtils.writeAtomic(this.lockfilePath(), `${JSON.stringify(lockfile, null, 2)}\n`);
	}

	async writeRecord(pluginId: string, record: InstalledPluginRecord, options: { replace: boolean }): Promise<void> {
		const lockfile = await this.read();
		if (lockfile.plugins[pluginId] && !options.replace) {
			throw new DomainError("validation", `Plugin ${pluginId} already exists in ${LOCKFILE_NAME}`, {
				code: "plugin.already_installed",
				params: { plugin: pluginId },
			});
		}

		lockfile.plugins[pluginId] = record;
		await this.write(lockfile);
	}

	resolveInstalledDirectory(pluginId: string, record: InstalledPluginRecord): string {
		// The directory name may differ from the plugin id (manually dropped
		// packages), so validate it as a plain basename and keep the resolved
		// path inside the plugins root.
		if (PathUtils.getFileName(pluginId) !== pluginId || PathUtils.getFileName(record.directory) !== record.directory) {
			throw new DomainError("validation", `Plugin ${pluginId} has an unsafe ${LOCKFILE_NAME} directory entry`, {
				code: "plugin.lockfile_entry_unsafe",
				params: { plugin: pluginId },
			});
		}

		const pluginsDirectory = PathUtils.resolve(this.pluginsDirectory);
		const directory = PathUtils.resolve(pluginsDirectory, record.directory);
		if (PathUtils.getDirName(directory) !== pluginsDirectory)
			throw new DomainError("validation", `Plugin ${pluginId} escapes the plugins directory`, {
				code: "plugin.directory_escape",
				params: { plugin: pluginId },
			});

		return directory;
	}

	private lockfilePath(): string {
		return PathUtils.join(PathUtils.resolve(this.pluginsDirectory), LOCKFILE_NAME);
	}
}

function isPluginLockfile(value: unknown): value is PluginLockfile {
	if (!isRecord(value) || value.version !== LOCKFILE_VERSION || !isRecord(value.plugins)) return false;

	return Object.values(value.plugins).every(
		(record) =>
			isRecord(record) &&
			isNonEmptyString(record.directory) &&
			isNonEmptyString(record.integrity) &&
			isNonEmptyString(record.installedAt) &&
			isNonEmptyString(record.source) &&
			isNonEmptyString(record.version) &&
			(record.disabled === undefined || typeof record.disabled === "boolean") &&
			(record.cspDisabled === undefined || typeof record.cspDisabled === "boolean") &&
			(record.pinned === undefined || typeof record.pinned === "boolean") &&
			(record.previous === undefined || isPreviousInstall(record.previous)),
	);
}

function isPreviousInstall(value: unknown): value is PluginPreviousInstall {
	return (
		isRecord(value) &&
		isNonEmptyString(value.version) &&
		isNonEmptyString(value.integrity) &&
		isNonEmptyString(value.installedAt) &&
		isNonEmptyString(value.source) &&
		isNonEmptyString(value.backupDirectory) &&
		(value.disabled === undefined || typeof value.disabled === "boolean") &&
		(value.cspDisabled === undefined || typeof value.cspDisabled === "boolean") &&
		(value.pinned === undefined || typeof value.pinned === "boolean")
	);
}
