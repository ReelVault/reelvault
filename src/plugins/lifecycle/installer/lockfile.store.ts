import { isMissingFile, ValidationError } from "@/utils/errors";
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
			if (!isPluginLockfile(parsed)) throw new ValidationError(`Invalid ${LOCKFILE_NAME}`);

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
			throw new ValidationError(`Plugin ${pluginId} already exists in ${LOCKFILE_NAME}`);
		}

		lockfile.plugins[pluginId] = record;
		await this.write(lockfile);
	}

	resolveInstalledDirectory(pluginId: string, record: InstalledPluginRecord): string {
		if (PathUtils.getFileName(pluginId) !== pluginId || record.directory !== pluginId) {
			throw new ValidationError(`Plugin ${pluginId} has an unsafe ${LOCKFILE_NAME} directory entry`);
		}

		const pluginsDirectory = PathUtils.resolve(this.pluginsDirectory);
		const directory = PathUtils.resolve(pluginsDirectory, record.directory);
		if (PathUtils.getDirName(directory) !== pluginsDirectory) throw new ValidationError(`Plugin ${pluginId} escapes the plugins directory`);

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
			(record.disabled === undefined || typeof record.disabled === "boolean"),
	);
}
