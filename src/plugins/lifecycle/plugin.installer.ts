import { chmod, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { file, write } from "bun";
import { systemResourcesService } from "@/system/system-resources.service";
import { DirUtils } from "@/utils/directory.utils";
import { ValidationError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { isNewerVersion } from "@/utils/semver.utils";
import { SERVER_VERSION } from "@/version";
import { isPluginDirectoryName } from "./host/plugin-directory.index";
import { calculateDirectoryIntegrity, MUTABLE_CONFIG_FILENAME } from "./installer/directory-hash";
import { type InstalledPluginRecord, LOCKFILE_NAME, type PluginLockfile, PluginLockfileStore } from "./installer/lockfile.store";
import { assertNoSymbolicLinks } from "./installer/symlink-guard";
import { loadPluginManifest, resolvePluginEntry } from "./plugin.manifest";

/** SHA-256 over large blobs — CPU+disk bound, so concurrency scales with measured capacity. */
const VERIFICATION_CONCURRENCY = () => clamp(Math.ceil(systemResourcesService.getMetrics().capacity / 2), 1, 8);

const logger = createLogger("PluginInstaller");

export type { InstalledPluginRecord } from "./installer/lockfile.store";

export interface InstalledPlugin {
	id: string;
	record: InstalledPluginRecord;
}

export interface InstallOptions {
	/**
	 * Replace an already-installed plugin of the same id. Without this flag a
	 * colliding target directory is a hard error — upgrades must be explicit.
	 */
	upgrade?: boolean;
	/** Recorded in the lockfile for provenance (defaults to the source directory). */
	source?: string;
}

export class PluginInstaller {
	private readonly pluginsDirectory: string;
	private readonly lockfileStore: PluginLockfileStore;

	constructor(pluginsDirectory: string) {
		this.pluginsDirectory = pluginsDirectory;
		this.lockfileStore = new PluginLockfileStore(pluginsDirectory);
	}

	async install(
		sourceDirectory: string,
		options: InstallOptions = {},
	): Promise<{ id: string; directory: string; record: InstalledPluginRecord }> {
		const source = PathUtils.resolve(sourceDirectory);
		const pluginsDirectory = PathUtils.resolve(this.pluginsDirectory);
		assertSeparateDirectories(source, pluginsDirectory);
		await assertSourceDirectory(source);
		await assertNoSymbolicLinks(source, VERIFICATION_CONCURRENCY());

		const manifest = await loadPluginManifest(source);
		if (manifest.minServerVersion && isNewerVersion(manifest.minServerVersion, SERVER_VERSION)) {
			throw new ValidationError(
				`Plugin ${manifest.id} ${manifest.version} requires server ${manifest.minServerVersion} or newer (running ${SERVER_VERSION}) — update the server first`,
				{ code: "plugin.server_too_old" },
			);
		}
		await assertFile(resolvePluginEntry(source, manifest), "Plugin entrypoint");

		const targetName = await this.resolveInstalledDirectoryName(manifest.id);
		const targetDirectory = PathUtils.join(pluginsDirectory, targetName);
		const targetExists = await DirUtils.exists(targetDirectory);
		if (targetExists && !options.upgrade) {
			throw new ValidationError(`Plugin ${manifest.id} is already installed in ${targetDirectory}`);
		}

		const isUpgrade = targetExists && options.upgrade === true;

		await mkdir(this.pluginsDirectory, { recursive: true });
		const stagingDirectory = PathUtils.join(pluginsDirectory, `.install-${manifest.id}-${crypto.randomUUID()}`);
		let backupDirectory: string | undefined;
		try {
			await cp(source, stagingDirectory, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
			await assertNoSymbolicLinks(stagingDirectory, VERIFICATION_CONCURRENCY());

			const installedManifest = await loadPluginManifest(stagingDirectory);
			if (installedManifest.id !== manifest.id || installedManifest.version !== manifest.version) {
				throw new ValidationError("Plugin manifest changed while the package was being installed");
			}

			// An upgrade replaces the whole package directory, but admin-entered
			// settings (API keys, toggles) live in `config.json` inside that
			// directory and must survive. Carry the previous file into the staged
			// build before the old directory is renamed aside.
			if (isUpgrade) {
				await preserveMutableConfig(targetDirectory, stagingDirectory);
			}

			const record: InstalledPluginRecord = {
				directory: PathUtils.getFileName(targetDirectory),
				integrity: await calculateDirectoryIntegrity(stagingDirectory),
				installedAt: new Date().toISOString(),
				source: options.source ?? source,
				version: manifest.version,
			};

			if (isUpgrade) {
				// Move the old installation aside; both renames are same-directory
				// so they are atomic on one filesystem. Restored on any failure below.
				backupDirectory = PathUtils.join(pluginsDirectory, `.upgrade-${manifest.id}-${crypto.randomUUID()}`);
				await rename(targetDirectory, backupDirectory);
			}

			try {
				await rename(stagingDirectory, targetDirectory);
			} catch (error) {
				if (backupDirectory) await rename(backupDirectory, targetDirectory);

				throw error;
			}

			try {
				await this.lockfileStore.writeRecord(manifest.id, record, { replace: isUpgrade });
			} catch (error) {
				await rm(targetDirectory, { recursive: true, force: true });
				if (backupDirectory) await rename(backupDirectory, targetDirectory);

				throw error;
			}

			if (backupDirectory) {
				await rm(backupDirectory, { recursive: true, force: true });
			}

			await this.removeDuplicateDirectories(manifest.id, targetName);

			return { id: manifest.id, directory: targetDirectory, record };
		} catch (error) {
			await rm(stagingDirectory, { recursive: true, force: true });
			throw error;
		}
	}

	/**
	 * Directory an id already lives in: the lockfile record wins, then a manifest
	 * scan. Falls back to the manifest id for a fresh install. Upgrading into the
	 * existing directory avoids a second directory for the same id, which would
	 * otherwise race at boot and make reloads pick an arbitrary build.
	 */
	private async resolveInstalledDirectoryName(pluginId: string): Promise<string> {
		const lockfile = await this.lockfileStore.read();
		const record = lockfile.plugins[pluginId];
		if (record && isPluginDirectoryName(record.directory) && PathUtils.getFileName(record.directory) === record.directory) {
			if (await DirUtils.exists(PathUtils.join(this.pluginsDirectory, record.directory))) return record.directory;
		}

		for (const dirName of await DirUtils.listDirs(this.pluginsDirectory)) {
			if (!isPluginDirectoryName(dirName)) continue;

			try {
				const manifest = await loadPluginManifest(PathUtils.join(this.pluginsDirectory, dirName));
				if (manifest.id === pluginId) return dirName;
			} catch {
				// Not a loadable plugin directory — ignore.
			}
		}

		return pluginId;
	}

	/** Best-effort removal of other directories carrying the same plugin id. */
	private async removeDuplicateDirectories(pluginId: string, targetName: string): Promise<void> {
		for (const dirName of await DirUtils.listDirs(this.pluginsDirectory)) {
			if (!isPluginDirectoryName(dirName) || dirName === targetName) continue;

			const directory = PathUtils.join(this.pluginsDirectory, dirName);
			let manifestId: string;
			try {
				manifestId = (await loadPluginManifest(directory)).id;
			} catch {
				continue;
			}

			if (manifestId !== pluginId) continue;

			try {
				await rm(directory, { recursive: true, force: true });
				logger.warn("Removed a duplicate plugin directory for the same plugin id", { pluginId, directory: dirName });
			} catch (error) {
				logger.warn("Could not remove a duplicate plugin directory", { pluginId, directory: dirName, error });
			}
		}
	}

	async list(): Promise<InstalledPlugin[]> {
		const lockfile = await this.lockfileStore.read();

		return Object.entries(lockfile.plugins)
			.map(([id, record]) => ({ id, record }))
			.toSorted((left, right) => left.id.localeCompare(right.id));
	}

	async verify(): Promise<InstalledPlugin[]> {
		const hashed = await this.hashInstalledPlugins();
		for (const { plugin, integrity } of hashed) {
			if (integrity !== plugin.record.integrity) {
				throw new ValidationError(`Plugin ${plugin.id} integrity does not match ${LOCKFILE_NAME}`);
			}
		}

		return hashed.map(({ plugin }) => plugin);
	}

	/**
	 * Advisory reconciliation: re-hashes every installed package and rewrites the
	 * lockfile record when it no longer matches. A package refreshed out-of-band
	 * stops reporting a false mismatch on every subsequent boot. Returns the ids
	 * whose records changed.
	 */
	async refreshIntegrity(): Promise<string[]> {
		const hashed = await this.hashInstalledPlugins();
		if (hashed.length === 0) return [];

		const lockfile = await this.lockfileStore.read();
		const refreshed: string[] = [];
		for (const { plugin, integrity } of hashed) {
			if (integrity === plugin.record.integrity) continue;

			lockfile.plugins[plugin.id] = { ...plugin.record, integrity };
			refreshed.push(plugin.id);
		}

		if (refreshed.length > 0) await this.lockfileStore.write(lockfile);

		return refreshed.toSorted((left, right) => left.localeCompare(right));
	}

	/** Re-hashes every installed package and returns each plugin with its current on-disk integrity. */
	private async hashInstalledPlugins(): Promise<Array<{ plugin: InstalledPlugin; integrity: string }>> {
		const plugins = await this.list();

		return await PromiseUtils.mapConcurrent(plugins, VERIFICATION_CONCURRENCY(), async (plugin) => {
			const directory = this.lockfileStore.resolveInstalledDirectory(plugin.id, plugin.record);
			await assertSourceDirectory(directory);
			await assertNoSymbolicLinks(directory, VERIFICATION_CONCURRENCY());

			return { plugin, integrity: await calculateDirectoryIntegrity(directory) };
		});
	}

	async setDisabled(pluginId: string, disabled: boolean): Promise<void> {
		const lockfile = await this.lockfileStore.read();
		const record = lockfile.plugins[pluginId];
		if (!record) throw new ValidationError(`Plugin ${pluginId} is not installed`);

		if (record.disabled === disabled) return;

		const updatedLockfile: PluginLockfile = {
			...lockfile,
			plugins: { ...lockfile.plugins, [pluginId]: { ...record, disabled } },
		};
		await this.lockfileStore.write(updatedLockfile);
	}

	async getDisabledIds(): Promise<Set<string>> {
		const lockfile = await this.lockfileStore.read();

		return new Set(
			Object.entries(lockfile.plugins)
				.filter(([, record]) => record.disabled === true)
				.map(([id]) => id),
		);
	}

	async uninstall(pluginId: string): Promise<InstalledPluginRecord> {
		const lockfile = await this.lockfileStore.read();
		const record = lockfile.plugins[pluginId];
		if (!record) throw new ValidationError(`Plugin ${pluginId} is not installed`);

		const directory = this.lockfileStore.resolveInstalledDirectory(pluginId, record);
		const updatedLockfile: PluginLockfile = { ...lockfile, plugins: { ...lockfile.plugins } };
		Reflect.deleteProperty(updatedLockfile.plugins, pluginId);
		await this.lockfileStore.write(updatedLockfile);

		try {
			await rm(directory, { recursive: true, force: true });
		} catch (error) {
			await this.lockfileStore.write(lockfile);
			throw error;
		}

		return record;
	}
}

async function assertSourceDirectory(directory: string): Promise<void> {
	const source = await stat(directory).catch(() => {
		// intentionally empty
	});
	if (!source?.isDirectory()) throw new ValidationError(`Plugin source directory does not exist: ${directory}`);
}

/**
 * Copies the admin-owned `config.json` from an existing installation into a
 * staged upgrade so a same-version rebuild does not wipe API keys or settings.
 * A missing config (fresh install / never configured) is a no-op.
 */
async function preserveMutableConfig(fromDirectory: string, toDirectory: string): Promise<void> {
	const sourcePath = PathUtils.join(fromDirectory, MUTABLE_CONFIG_FILENAME);
	if (!(await file(sourcePath).exists())) return;

	const targetPath = PathUtils.join(toDirectory, MUTABLE_CONFIG_FILENAME);
	await write(targetPath, file(sourcePath));
	await chmod(targetPath, 0o600).catch(() => {
		// Non-POSIX filesystems may not support chmod — the copy still succeeded.
	});
}

async function assertFile(path: string, name: string): Promise<void> {
	const metadata = await stat(path).catch(() => {
		// intentionally empty
	});
	if (!metadata?.isFile()) throw new ValidationError(`${name} does not exist: ${path}`);
}

function assertSeparateDirectories(source: string, pluginsDirectory: string): void {
	if (isWithinDirectory(source, pluginsDirectory) || isWithinDirectory(pluginsDirectory, source)) {
		throw new ValidationError("Plugin source directory must not overlap with the destination plugins directory");
	}
}

function isWithinDirectory(path: string, directory: string): boolean {
	return PathUtils.resolve(path) === PathUtils.resolve(directory) || PathUtils.isSubpath(path, directory);
}
