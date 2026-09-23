import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPluginRuntimes, materializePluginRuntime, pluginRuntimeRoot, removePluginRuntime } from "./plugin-runtime-copy";

const temporaryDirectories: string[] = [];

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
	for (const [relativePath, content] of Object.entries(files)) {
		const target = join(root, relativePath);
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, content);
	}
}

describe("plugin runtime copy", () => {
	let pluginsDirectory: string;

	beforeEach(async () => {
		pluginsDirectory = await mkdtemp(join(tmpdir(), "reelvault-runtime-"));
		temporaryDirectories.push(pluginsDirectory);
	});

	afterEach(async () => {
		await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
	});

	test("pluginRuntimeRoot nests the .runtime directory under the plugins root", () => {
		expect(pluginRuntimeRoot("/plugins")).toBe(join("/plugins", ".runtime"));
	});

	test("materializePluginRuntime mirrors the whole package into a unique directory", async () => {
		const pluginDir = join(pluginsDirectory, "pkg");
		await writeTree(pluginDir, {
			"index.mjs": "export default {};\n",
			"lib/dep.mjs": "export const dep = 1;\n",
		});

		const runtimeDir = await materializePluginRuntime(pluginDir, pluginRuntimeRoot(pluginsDirectory));

		expect(runtimeDir).toContain(join(".runtime"));
		expect(runtimeDir).not.toBe(pluginDir);
		await expect(Bun.file(join(runtimeDir, "index.mjs")).text()).resolves.toBe("export default {};\n");
		await expect(Bun.file(join(runtimeDir, "lib", "dep.mjs")).text()).resolves.toBe("export const dep = 1;\n");

		const second = await materializePluginRuntime(pluginDir, pluginRuntimeRoot(pluginsDirectory));
		expect(second).not.toBe(runtimeDir);
	});

	test("materialization skips .git directories and mirrors regular files of symlinked trees", async () => {
		const pluginDir = join(pluginsDirectory, "pkg");
		const outsideDir = join(pluginsDirectory, "outside");
		await writeTree(pluginDir, { "index.mjs": "export default {};\n", ".git/HEAD": "ref: refs/heads/main\n" });
		await writeTree(outsideDir, { "shared.txt": "shared content\n" });
		await symlink(outsideDir, join(pluginDir, "vendor"));

		const runtimeDir = await materializePluginRuntime(pluginDir, pluginRuntimeRoot(pluginsDirectory));

		const gitHead = Bun.file(join(runtimeDir, ".git", "HEAD"));
		await expect(gitHead.exists()).resolves.toBeFalse();
		await expect(Bun.file(join(runtimeDir, "vendor", "shared.txt")).text()).resolves.toBe("shared content\n");
	});

	test("a symlink loop terminates and copies the linked directory once", async () => {
		const pluginDir = join(pluginsDirectory, "pkg");
		await writeTree(pluginDir, { "index.mjs": "export default {};\n", "nested/inner.txt": "inner\n" });
		const realNested = await realpath(join(pluginDir, "nested"));
		await symlink(realNested, join(pluginDir, "loop"));

		const runtimeDir = await materializePluginRuntime(pluginDir, pluginRuntimeRoot(pluginsDirectory));

		await expect(Bun.file(join(runtimeDir, "loop", "inner.txt")).text()).resolves.toBe("inner\n");
	});

	test("clearPluginRuntimes wipes every materialized runtime", async () => {
		const pluginDir = join(pluginsDirectory, "pkg");
		await writeTree(pluginDir, { "index.mjs": "export default {};\n" });
		await materializePluginRuntime(pluginDir, pluginRuntimeRoot(pluginsDirectory));

		await clearPluginRuntimes(pluginRuntimeRoot(pluginsDirectory));

		await expect(Bun.file(pluginRuntimeRoot(pluginsDirectory)).exists()).resolves.toBeFalse();
	});

	test("removePluginRuntime removes one runtime and tolerates a missing path", async () => {
		const pluginDir = join(pluginsDirectory, "pkg");
		await writeTree(pluginDir, { "index.mjs": "export default {};\n" });
		const runtimeDir = await materializePluginRuntime(pluginDir, pluginRuntimeRoot(pluginsDirectory));

		await removePluginRuntime(runtimeDir);
		await expect(Bun.file(join(runtimeDir, "index.mjs")).exists()).resolves.toBeFalse();
		await expect(removePluginRuntime(undefined)).resolves.toBeUndefined();
		await expect(removePluginRuntime(join(pluginsDirectory, "never-created"))).resolves.toBeUndefined();
	});
});
