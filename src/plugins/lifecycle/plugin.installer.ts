import { cp, mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PluginInstallDirection } from "@reelvault/sdk/common";
import { resolvePluginDirectoryName } from "@/plugins/lifecycle/host/plugin-directory.resolver";
import { directoryExists, removeTree } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { mapConcurrent } from "@/utils/promise.utils";
import { isNewerVersion } from "@/utils/semver.utils";
import { readPluginManifests } from "./host/plugin-directory.reader";
import { activateStagedPackage } from "./installer/activate.service";
import {
	assertPackageDirectory,
	assertSeparateDirectories,
	loadInstallableManifest,
	verificationConcurrency,
} from "./installer/checks.guard";
import {
	backupMutableConfig,
	discardConfigBackup,
	preserveMutableConfig,
	restoreUninstalledConfig,
} from "./installer/config-backup.service";
import { calculateDirectoryIntegrity } from "./installer/directory-hash.utils";
import { type InstalledPluginRecord, LOCKFILE_NAME, type PluginLockfile, PluginLockfileStore } from "./installer/lockfile.store";
import { buildInstallRecord, restoredRecord } from "./installer/records.mapper";
import { assertNoSymbolicLinks } from "./installer/symlink.guard";
import { loadPluginManifest } from "./plugin.manifest";

const logger = createLogger("PluginInstaller");

export type { InstalledPluginRecord } from "./installer/lockfile.store";

/** Direction of an install relative to the version it replaces. An unordered pair is a plain replacement. */
export function installDirection(previousVersion: string | undefined, version: string): PluginInstallDirection {
	if (previousVersion === undefined) return "install";
	if (previousVersion === version) return "reinstall";

	return isNewerVersion(previousVersion, version) ? "downgrade" : "upgrade";
}

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

interface InstallResult {
	id: string;
	directory: string;
	record: InstalledPluginRecord;
}

/** A package copied into staging and checked, waiting to be swapped in. */
interface StagedInstall {
	pluginsDirectory: string;
	stagingDirectory: string;
	targetName: string;
	targetDirectory: string;
	manifest: { id: string; version: string };
	recordedSource: string;
	isUpgrade: boolean;
}

/** An admin choice stored on a lockfile record. */
type AdminFlag = "disabled" | "cspDisabled" | "pinned";

export class PluginInstaller {
	private readonly pluginsDirectory: string;
	private readonly lockfileStore: PluginLockfileStore;

	constructor(pluginsDirectory: string) {
		this.pluginsDirectory = pluginsDirectory;
		this.lockfileStore = new PluginLockfileStore(pluginsDirectory);
	}

	async install(sourceDirectory: string, options: InstallOptions = {}): Promise<InstallResult> {
		const source = resolve(sourceDirectory);
		const pluginsDirectory = resolve(this.pluginsDirectory);
		assertSeparateDirectories(source, pluginsDirectory);
		await assertPackageDirectory(source);

		const manifest = await loadInstallableManifest(source);
		const targetName = await this.resolveInstalledDirectoryName(manifest.id);
		const targetDirectory = join(pluginsDirectory, targetName);
		const targetExists = await directoryExists(targetDirectory);
		if (targetExists && !options.upgrade) {
			throw new DomainError("validation", `Plugin ${manifest.id} is already installed in ${targetDirectory}`, {
				code: "plugin.already_installed",
				params: { pluginId: manifest.id },
			});
		}

		const isUpgrade = targetExists && options.upgrade === true;

		await mkdir(this.pluginsDirectory, { recursive: true });
		const stagingDirectory = join(pluginsDirectory, `.install-${manifest.id}-${crypto.randomUUID()}`);
		try {
			await stagePackage(source, stagingDirectory, manifest);

			// An upgrade replaces the whole package directory, but admin-entered
			// settings (API keys, toggles) live in `config.json` inside that
			// directory and must survive. Carry the previous file into the staged
			// build before the old directory is renamed aside. A fresh install of a
			// plugin that was uninstalled gets its configuration back from the backup
			// taken then.
			if (isUpgrade) await preserveMutableConfig(targetDirectory, stagingDirectory);
			else await restoreUninstalledConfig(pluginsDirectory, manifest.id, stagingDirectory);

			return await this.commitStagedInstall({
				pluginsDirectory,
				stagingDirectory,
				targetName,
				targetDirectory,
				manifest,
				recordedSource: options.source ?? source,
				isUpgrade,
			});
		} catch (error) {
			await removeTree(stagingDirectory);
			throw error;
		}
	}

	/**
	 * Swaps the staged package into place and records it. A failed record write
	 * puts the package it replaced back, and the replaced package stays as the
	 * rollback point of an upgrade.
	 */
	private async commitStagedInstall(staged: StagedInstall): Promise<InstallResult> {
		const { pluginsDirectory, stagingDirectory, targetName, targetDirectory, manifest, recordedSource, isUpgrade } = staged;
		// The lockfile record decides whether the entry may be replaced — a record
		// whose directory is missing must still be replaceable, or reinstall is
		// refused with `plugin.already_installed` forever.
		const existingRecord = (await this.lockfileStore.read()).plugins[manifest.id];
		const previousRecord = isUpgrade ? existingRecord : undefined;
		// An upgrade keeps the package it replaces as a rollback point (`previous`). Without a lockfile record there is nothing to roll back to.
		let backupDirectory: string | undefined;
		if (isUpgrade) {
			backupDirectory = join(pluginsDirectory, `.upgrade-${manifest.id}-${crypto.randomUUID()}`);
		}

		const record = buildInstallRecord({
			targetDirectory,
			version: manifest.version,
			integrity: await calculateDirectoryIntegrity(stagingDirectory),
			source: recordedSource,
			previousRecord,
			backupDirectory,
		});

		await activateStagedPackage({ stagingDirectory, targetDirectory, backupDirectory });

		try {
			await this.lockfileStore.writeRecord(manifest.id, record, { replace: existingRecord !== undefined });
		} catch (error) {
			await removeTree(targetDirectory);
			if (backupDirectory) await rename(backupDirectory, targetDirectory);

			throw error;
		}

		// Only the package this upgrade replaced is dropped: a second upgrade before the first is confirmed.
		if (backupDirectory && !record.previous) await removeTree(backupDirectory);
		if (previousRecord?.previous) await removeTree(join(pluginsDirectory, previousRecord.previous.backupDirectory));
		if (!isUpgrade) await discardConfigBackup(pluginsDirectory, manifest.id);

		await this.removeDuplicateDirectories(manifest.id, targetName);

		return { id: manifest.id, directory: targetDirectory, record };
	}

	/**
	 * Directory an id already lives in: the lockfile record wins, then a manifest
	 * scan. Falls back to the manifest id for a fresh install. Upgrading into the
	 * existing directory avoids a second directory for the same id, which would
	 * otherwise race at boot and make reloads pick an arbitrary build.
	 */
	private async resolveInstalledDirectoryName(pluginId: string): Promise<string> {
		const lockfile = await this.lockfileStore.read();
		const resolved = await resolvePluginDirectoryName(pluginId, lockfile, this.pluginsDirectory);

		return resolved ?? pluginId;
	}

	/** Best-effort removal of other directories carrying the same plugin id. */
	private async removeDuplicateDirectories(pluginId: string, targetName: string): Promise<void> {
		for await (const { directoryName, manifest } of readPluginManifests(this.pluginsDirectory)) {
			if (directoryName === targetName || manifest.id !== pluginId) continue;

			try {
				await removeTree(join(this.pluginsDirectory, directoryName));
				logger.warn("Removed a duplicate plugin directory for the same plugin id", { pluginId, directory: directoryName });
			} catch (error) {
				logger.warn("Could not remove a duplicate plugin directory", { pluginId, directory: directoryName, error });
			}
		}
	}

	/**
	 * Drops the rollback point of an upgrade once the new version has loaded.
	 * Returns whether there was one to drop.
	 */
	async confirmUpgrade(pluginId: string): Promise<boolean> {
		const lockfile = await this.lockfileStore.read();
		const record = lockfile.plugins[pluginId];
		if (!record?.previous) return false;

		const confirmed: InstalledPluginRecord = { ...record };
		Reflect.deleteProperty(confirmed, "previous");
		lockfile.plugins[pluginId] = confirmed;
		await this.lockfileStore.write(lockfile);
		await removeTree(join(this.pluginsDirectory, record.previous.backupDirectory));

		return true;
	}

	/**
	 * Puts the package an unconfirmed upgrade replaced back in place and restores
	 * its lockfile record. The configuration saved since the upgrade is carried
	 * over. Returns the restored record, or undefined when there is no rollback point.
	 */
	async rollbackUpgrade(pluginId: string): Promise<InstalledPluginRecord | undefined> {
		const lockfile = await this.lockfileStore.read();
		const record = lockfile.plugins[pluginId];
		if (!record?.previous) return undefined;

		const current = this.lockfileStore.resolveInstalledDirectory(pluginId, record);
		const backup = join(this.pluginsDirectory, record.previous.backupDirectory);
		const failed = join(this.pluginsDirectory, `.failed-${pluginId}-${crypto.randomUUID()}`);

		// Same-directory renames, so the failed build is moved aside before the previous package takes its place.
		await rename(current, failed);
		try {
			await rename(backup, current);
		} catch (error) {
			await rename(failed, current);

			throw error;
		}
		await preserveMutableConfig(failed, current);
		await removeTree(failed);

		const restored = restoredRecord(record.previous, record.directory);
		lockfile.plugins[pluginId] = restored;
		await this.lockfileStore.write(lockfile);

		return restored;
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
				throw new DomainError("validation", `Plugin ${plugin.id} integrity does not match ${LOCKFILE_NAME}`, {
					code: "plugin.integrity_mismatch",
					params: { plugin: plugin.id },
				});
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

		return await mapConcurrent(plugins, verificationConcurrency(), async (plugin) => {
			const directory = this.lockfileStore.resolveInstalledDirectory(plugin.id, plugin.record);
			await assertPackageDirectory(directory);

			return { plugin, integrity: await calculateDirectoryIntegrity(directory) };
		});
	}

	/** Admin choice: keep the installed version, so the catalog offers no update for it. */
	async setPinned(pluginId: string, pinned: boolean): Promise<void> {
		await this.setAdminFlag(pluginId, "pinned", pinned);
	}

	/** Admin choice: whether the plugin's manifest may extend the content security policy. */
	async setCspDisabled(pluginId: string, disabled: boolean): Promise<void> {
		await this.setAdminFlag(pluginId, "cspDisabled", disabled);
	}

	async setDisabled(pluginId: string, disabled: boolean): Promise<void> {
		await this.setAdminFlag(pluginId, "disabled", disabled);
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
		const record = requireRecord(lockfile, pluginId);

		const directory = this.lockfileStore.resolveInstalledDirectory(pluginId, record);
		const updatedLockfile: PluginLockfile = { ...lockfile, plugins: { ...lockfile.plugins } };
		Reflect.deleteProperty(updatedLockfile.plugins, pluginId);
		await this.lockfileStore.write(updatedLockfile);

		try {
			await backupMutableConfig(directory, this.pluginsDirectory, pluginId);
			await removeTree(directory);
		} catch (error) {
			await this.lockfileStore.write(lockfile);
			throw error;
		}

		if (record.previous) {
			await removeTree(join(this.pluginsDirectory, record.previous.backupDirectory));
		}

		return record;
	}

	private async setAdminFlag(pluginId: string, flag: AdminFlag, value: boolean): Promise<void> {
		const lockfile = await this.lockfileStore.read();
		const record = requireRecord(lockfile, pluginId);
		if (record[flag] === value) return;

		await this.lockfileStore.write({ ...lockfile, plugins: { ...lockfile.plugins, [pluginId]: { ...record, [flag]: value } } });
	}
}

function requireRecord(lockfile: PluginLockfile, pluginId: string): InstalledPluginRecord {
	const record = lockfile.plugins[pluginId];
	if (!record) {
		throw new DomainError("validation", `Plugin ${pluginId} is not installed`, {
			code: "plugin.not_installed",
			params: { plugin: pluginId },
		});
	}

	return record;
}

/** Copies the source into staging and checks the copy is the same, symlink-free plugin. */
async function stagePackage(source: string, stagingDirectory: string, manifest: { id: string; version: string }): Promise<void> {
	await cp(source, stagingDirectory, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
	await assertNoSymbolicLinks(stagingDirectory, verificationConcurrency());

	// The staged copy is compared against the manifest the install started
	// with — a cached read would hide a manifest that changed meanwhile.
	const installedManifest = await loadPluginManifest(stagingDirectory, { fresh: true });
	if (installedManifest.id !== manifest.id || installedManifest.version !== manifest.version) {
		throw new DomainError("validation", "Plugin manifest changed while the package was being installed", {
			code: "plugin.manifest_changed",
		});
	}
}
