import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { serverConfig } from "@/config/server/server.config";

/**
 * Plugin package staging lives under the configured data root, not `os.tmpdir()`.
 * Many NAS/container hosts mount `/tmp` as tmpfs, so a 200-512 MB package would
 * consume RAM instead of disk.
 */
export async function pluginPackageTempDirectory(prefix: string): Promise<string> {
	const root = join(serverConfig.paths.tasks, "plugin-packages");
	await mkdir(root, { recursive: true });

	return await mkdtemp(join(root, prefix));
}
