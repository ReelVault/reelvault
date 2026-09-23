import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPluginDirectoryName, PluginDirectoryIndex } from "./plugin-directory.index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
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
	const root = await mkdtemp(join(tmpdir(), "reelvault-plugin-index-"));
	temporaryDirectories.push(root);

	return root;
}

describe("PluginDirectoryIndex", () => {
	test("distinguishes plugin package directories from support directories", () => {
		expect(isPluginDirectoryName("org.reelvault.x")).toBe(true);
		expect(isPluginDirectoryName("node_modules")).toBe(false);
		expect(isPluginDirectoryName(".runtime")).toBe(false);
	});

	test("set, get, and delete round-trip entries", () => {
		const index = new PluginDirectoryIndex();
		expect(index.get("org.reelvault.x")).toBeUndefined();

		index.set("org.reelvault.x", "org.reelvault.x");
		expect(index.get("org.reelvault.x")).toBe("org.reelvault.x");

		index.delete("org.reelvault.x");
		expect(index.get("org.reelvault.x")).toBeUndefined();
	});

	test("refresh indexes plugin manifests and skips non-package directories", async () => {
		const pluginsDirectory = await createPluginsRoot();
		await writePlugin(pluginsDirectory, "pkg-a", "org.reelvault.a");
		await writePlugin(pluginsDirectory, "pkg-b", "org.reelvault.b");
		await mkdir(join(pluginsDirectory, "node_modules"), { recursive: true });
		await mkdir(join(pluginsDirectory, ".runtime"), { recursive: true });
		await mkdir(join(pluginsDirectory, "not-a-plugin"), { recursive: true });

		const index = new PluginDirectoryIndex();
		await index.refresh(pluginsDirectory);

		expect(index.get("org.reelvault.a")).toBe("pkg-a");
		expect(index.get("org.reelvault.b")).toBe("pkg-b");
		expect(index.get("not-a-plugin")).toBeUndefined();
	});

	test("refresh keeps already-known directories untouched", async () => {
		const pluginsDirectory = await createPluginsRoot();
		await writePlugin(pluginsDirectory, "pkg-a", "org.reelvault.a");
		const index = new PluginDirectoryIndex();
		index.set("org.reelvault.a", "pkg-a");
		await rm(join(pluginsDirectory, "pkg-a", "plugin.json"));

		await index.refresh(pluginsDirectory);

		expect(index.get("org.reelvault.a")).toBe("pkg-a");
	});

	test("resolve returns a live indexed entry without rescanning", async () => {
		const pluginsDirectory = await createPluginsRoot();
		await writePlugin(pluginsDirectory, "pkg-a", "org.reelvault.a");
		const index = new PluginDirectoryIndex();
		index.set("org.reelvault.a", "pkg-a");

		await expect(index.resolve("org.reelvault.a", pluginsDirectory)).resolves.toBe("pkg-a");
	});

	test("resolve drops a stale entry and finds nothing when the package is gone", async () => {
		const pluginsDirectory = await createPluginsRoot();
		const index = new PluginDirectoryIndex();
		index.set("org.reelvault.gone", "org.reelvault.gone");

		await expect(index.resolve("org.reelvault.gone", pluginsDirectory)).resolves.toBeUndefined();
		expect(index.get("org.reelvault.gone")).toBeUndefined();
	});

	test("resolve rebuilds the index from manifests when the id is unknown", async () => {
		const pluginsDirectory = await createPluginsRoot();
		await writePlugin(pluginsDirectory, "renamed-dir", "org.reelvault.renamed");
		const index = new PluginDirectoryIndex();

		await expect(index.resolve("org.reelvault.renamed", pluginsDirectory)).resolves.toBe("renamed-dir");
	});
});
