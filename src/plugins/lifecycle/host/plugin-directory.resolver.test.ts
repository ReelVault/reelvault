import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginLockfile } from "@/plugins/lifecycle/installer/lockfile.store";
import { removeTree } from "@/utils/directory.utils";
import { resolvePluginDirectoryName } from "./plugin-directory.resolver";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await removeTree(directory)));
});

async function writePlugin(pluginsDirectory: string, directoryName: string, id: string): Promise<void> {
	const pluginDirectory = join(pluginsDirectory, directoryName);
	await mkdir(pluginDirectory, { recursive: true });
	await writeFile(
		join(pluginDirectory, "plugin.json"),
		JSON.stringify({ id, name: id, version: "1.0.0", entry: "./index.mjs", capabilities: ["eventHandler"] }),
	);
	await writeFile(join(pluginDirectory, "index.mjs"), "export default { setup() {} };\n");
}

async function createPluginsRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "reelvault-plugin-resolver-"));
	temporaryDirectories.push(root);

	return root;
}

const EMPTY_LOCKFILE: PluginLockfile = { version: 1, plugins: {} };

describe("resolvePluginDirectoryName", () => {
	test("returns the lockfile directory even when the manifest has a different id", async () => {
		const pluginsDirectory = await createPluginsRoot();
		await writePlugin(pluginsDirectory, "locked-dir", "org.reelvault.other");
		const lockfile: PluginLockfile = {
			version: 1,
			plugins: {
				"org.reelvault.locked": {
					directory: "locked-dir",
					integrity: "sha256-abc",
					installedAt: "2026-01-01T00:00:00.000Z",
					source: "registry",
					version: "1.0.0",
				},
			},
		};

		await expect(resolvePluginDirectoryName("org.reelvault.locked", lockfile, pluginsDirectory)).resolves.toBe("locked-dir");
	});

	test("skips a manifest whose id differs from the requested plugin", async () => {
		const pluginsDirectory = await createPluginsRoot();
		await writePlugin(pluginsDirectory, "other-dir", "org.reelvault.other");

		await expect(resolvePluginDirectoryName("org.reelvault.wanted", EMPTY_LOCKFILE, pluginsDirectory)).resolves.toBeUndefined();
	});

	test("returns the manifest directory when the lockfile has no record", async () => {
		const pluginsDirectory = await createPluginsRoot();
		await writePlugin(pluginsDirectory, "dropped-dir", "org.reelvault.dropped");

		await expect(resolvePluginDirectoryName("org.reelvault.dropped", EMPTY_LOCKFILE, pluginsDirectory)).resolves.toBe("dropped-dir");
	});
});
