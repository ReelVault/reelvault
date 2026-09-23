import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { PluginConfig } from "./plugin.config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("plugin configuration", () => {
	test("loads and saves configuration values directly for administration", async () => {
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
		await expect(config.get("org.reelvault.config")).resolves.toEqual({
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

	test("rejects unsafe directory names", async () => {
		const pluginsDirectory = await createPluginsDirectory();
		const config = new PluginConfig(pluginsDirectory);
		await expect(config.get("../outside")).rejects.toThrow("invalid directory name");
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
