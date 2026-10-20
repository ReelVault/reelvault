import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { file, write } from "bun";
import { MUTABLE_CONFIG_FILENAME } from "./directory-hash.utils";

/** Uninstalled configurations wait here until the same plugin is installed again. Dot-directory, so it is never a plugin. */
const CONFIG_BACKUP_DIRECTORY = ".config-backups";

function configBackupPath(pluginsDirectory: string, pluginId: string): string {
	return join(pluginsDirectory, CONFIG_BACKUP_DIRECTORY, `${pluginId}.json`);
}

/** Copies a config file with owner-only permissions. Non-POSIX filesystems may not support chmod, so that failure is ignored. */
async function copyOwnerOnly(sourcePath: string, targetPath: string): Promise<void> {
	await write(targetPath, file(sourcePath));
	await chmod(targetPath, 0o600).catch(() => {
		// Non-POSIX filesystems may not support chmod — the copy still succeeded.
	});
}

/**
 * Copies the admin-owned `config.json` from an existing installation into a
 * staged upgrade so a same-version rebuild does not wipe API keys or settings.
 * A missing config (fresh install / never configured) is a no-op.
 */
export async function preserveMutableConfig(fromDirectory: string, toDirectory: string): Promise<void> {
	const sourcePath = join(fromDirectory, MUTABLE_CONFIG_FILENAME);
	if (!(await file(sourcePath).exists())) return;

	await copyOwnerOnly(sourcePath, join(toDirectory, MUTABLE_CONFIG_FILENAME));
}

/** Keeps an uninstalled plugin's config so a later install of the same id gets it back. */
export async function backupMutableConfig(fromDirectory: string, pluginsDirectory: string, pluginId: string): Promise<void> {
	const sourcePath = join(fromDirectory, MUTABLE_CONFIG_FILENAME);
	if (!(await file(sourcePath).exists())) return;

	await mkdir(join(pluginsDirectory, CONFIG_BACKUP_DIRECTORY), { recursive: true });
	await copyOwnerOnly(sourcePath, configBackupPath(pluginsDirectory, pluginId));
}

export async function restoreUninstalledConfig(pluginsDirectory: string, pluginId: string, toDirectory: string): Promise<void> {
	const backupPath = configBackupPath(pluginsDirectory, pluginId);
	if (!(await file(backupPath).exists())) return;

	await copyOwnerOnly(backupPath, join(toDirectory, MUTABLE_CONFIG_FILENAME));
}

export async function discardConfigBackup(pluginsDirectory: string, pluginId: string): Promise<void> {
	await rm(configBackupPath(pluginsDirectory, pluginId), { force: true });
}
