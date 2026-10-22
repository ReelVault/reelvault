import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { removeTree } from "@/utils/directory.utils";
import { PluginConfig } from "./plugin.config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await removeTree(directory)));
});

describe("plugin configuration", () => {
	test("reports an unreadable config.json without treating it as saved values", async () => {
		const pluginsDirectory = await createPluginsDirectory();
		const pluginDirectory = join(pluginsDirectory, "org.reelvault.broken");
		await mkdir(pluginDirectory, { recursive: true });
		await write(join(pluginDirectory, "config.json"), "{ not json");
		const config = new PluginConfig(pluginsDirectory);

		await expect(config.readError(pluginDirectory)).resolves.toBe("plugin.config_unreadable");
		await expect(config.load(pluginDirectory)).resolves.toEqual({});
	});

	test("reports no read error when config.json is absent or valid", async () => {
		const pluginsDirectory = await createPluginsDirectory();
		await writeConfig(pluginsDirectory, "org.reelvault.valid", { titlePrefix: "Example" });
		const config = new PluginConfig(pluginsDirectory);

		await expect(config.readError(join(pluginsDirectory, "org.reelvault.valid"))).resolves.toBeUndefined();
		await expect(config.readError(join(pluginsDirectory, "org.reelvault.absent"))).resolves.toBeUndefined();
	});

	test("save merges an update into the stored config and keeps the keys it does not name", async () => {
		const pluginsDirectory = await createPluginsDirectory();
		await writeConfig(pluginsDirectory, "org.reelvault.config", {
			titlePrefix: "Example",
			apiKey: "my-super-secret-api-key",
			nested: { accessToken: "access-token-value" },
		});
		const config = new PluginConfig(pluginsDirectory);

		await expect(config.load(join(pluginsDirectory, "org.reelvault.config"))).resolves.toEqual({
			titlePrefix: "Example",
			apiKey: "my-super-secret-api-key",
			nested: { accessToken: "access-token-value" },
		});

		await config.save("org.reelvault.config", {
			titlePrefix: "Updated Example",
			apiKey: "new-secret-key",
		});

		await expect(config.load(join(pluginsDirectory, "org.reelvault.config"))).resolves.toEqual({
			titlePrefix: "Updated Example",
			apiKey: "new-secret-key",
			nested: { accessToken: "access-token-value" },
		});
	});

	test("removes the listed keys before merging, so a reset leaves the other values in place", async () => {
		const pluginsDirectory = await createPluginsDirectory();
		await writeConfig(pluginsDirectory, "org.reelvault.reset", { titlePrefix: "Example", apiKey: "secret" });
		const config = new PluginConfig(pluginsDirectory);

		const saved = await config.save("org.reelvault.reset", { titlePrefix: "Updated" }, undefined, ["apiKey"]);

		expect(saved).toEqual({ titlePrefix: "Updated" });
		expect(await config.load(join(pluginsDirectory, "org.reelvault.reset"))).toEqual({ titlePrefix: "Updated" });
	});

	test("rejects unsafe directory names", async () => {
		const pluginsDirectory = await createPluginsDirectory();
		const config = new PluginConfig(pluginsDirectory);

		expect(() => config.resolvePluginDirectory("../outside")).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.config_directory_invalid" }),
		);
	});

	test("writes the config file with owner-only permissions", async () => {
		const pluginsDirectory = await createPluginsDirectory();
		const pluginName = "org.reelvault.secure";
		await mkdir(join(pluginsDirectory, pluginName), { recursive: true });
		const config = new PluginConfig(pluginsDirectory);

		await config.save(pluginName, { apiKey: "secret" });

		const metadata = await stat(join(pluginsDirectory, pluginName, "config.json"));
		expect(metadata.mode & 0o777).toBe(0o600);
	});
});

async function createPluginsDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-plugin-config-"));
	temporaryDirectories.push(directory);

	return directory;
}

async function writeConfig(pluginsDirectory: string, pluginName: string, config: Record<string, unknown>): Promise<void> {
	const pluginDirectory = join(pluginsDirectory, pluginName);
	await mkdir(pluginDirectory, { recursive: true });
	await write(join(pluginDirectory, "config.json"), JSON.stringify(config));
}
