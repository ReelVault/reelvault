import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { removeTree } from "@/utils/directory.utils";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { PluginManager } from "./manager/plugin-manager.service";
import { pluginRegistry } from "./plugin.registry";

/**
 * Plugins here are real packages: a manifest and an entry module loaded from disk.
 * The entry records what happens to it in a global log, and a test makes a plugin
 * fail by listing its `id@version` in the failure sets. Nothing inside the manager is stubbed.
 */
const CONTROL_KEY = "__reelvaultPluginManagerTest";

interface PluginControl {
	events: string[];
	failSetup: Set<string>;
	failUnload: Set<string>;
}

/** Config definitions as the loader reads them from a plugin's default export. */
const REQUIRED_API_KEY_CONFIG = `config: {
		fields: {},
		descriptors: [{ name: "apiKey", type: "secret", label: "API key", required: true }],
		parse(value) {
			return { apiKey: value.apiKey ?? "" };
		},
	},`;

const API_KEY_AND_THEME_CONFIG = `config: {
		fields: {},
		descriptors: [
			{ name: "apiKey", type: "secret", label: "API key", required: true },
			{ name: "theme", type: "string", label: "Theme" },
		],
		parse(value) {
			return { apiKey: value.apiKey ?? "", theme: value.theme ?? "dark" };
		},
	},`;

const LOCALE_CONFIG = `config: {
		fields: {},
		descriptors: [{ name: "language", type: "string", label: "Language" }],
		parse(value) {
			if (!/^[a-z]{2}-[A-Z]{2}$/.test(String(value.language ?? ""))) {
				throw new Error("Plugin configuration 'language' does not match the expected format");
			}
			return value;
		},
	},`;

function resetControl(): void {
	(globalThis as Record<string, unknown>)[CONTROL_KEY] = {
		events: [],
		failSetup: new Set(),
		failUnload: new Set(),
	} satisfies PluginControl;
}

function readControl(): PluginControl {
	return (globalThis as Record<string, unknown>)[CONTROL_KEY] as PluginControl;
}

useTestDatabase();

let sourcesRoot = "";

beforeEach(async () => {
	resetControl();
	await removeTree(serverConfig.paths.plugins);
	await mkdir(serverConfig.paths.plugins, { recursive: true });
	sourcesRoot = await mkdtemp(join(tmpdir(), "reelvault-manager-sources-"));
});

afterEach(async () => {
	pluginRegistry.clear();
	await removeTree(sourcesRoot);
	await removeTree(serverConfig.paths.plugins);
	(globalThis as Record<string, unknown>)[CONTROL_KEY] = undefined;
});

interface PackageOptions {
	name?: string;
	/** Extra members of the default export, such as a `config` definition. */
	exportMembers?: string;
}

/** A plugin source directory with a manifest and an entry module. The directory is outside the plugins root. */
async function writePackage(id: string, version: string, options: PackageOptions = {}): Promise<string> {
	const directory = join(sourcesRoot, `${id}-${version}-${crypto.randomUUID()}`);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "plugin.json"),
		JSON.stringify({
			id,
			name: options.name ?? `Manager ${id}`,
			version,
			entry: "./index.mjs",
			capabilities: ["eventHandler"],
		}),
	);
	await writeFile(join(directory, "index.mjs"), entrySource(id, version, options.exportMembers ?? ""));

	return directory;
}

function entrySource(id: string, version: string, exportMembers: string): string {
	const key = JSON.stringify(`${id}@${version}`);
	const name = JSON.stringify(id);
	const control = JSON.stringify(CONTROL_KEY);

	return `const control = () => globalThis[${control}];
export default {
	${exportMembers}
	setup() {
		control().events.push("setup:" + ${name});
		if (control().failSetup.has(${key})) throw new Error("setup failed for " + ${key});
	},
	onUnload() {
		control().events.push("unload:" + ${name});
		if (control().failUnload.has(${key})) throw new Error("onUnload failed for " + ${key});
	},
};
`;
}

/** The plugin's directory under the plugins root, as the installer named it. */
async function installedDirectory(manager: PluginManager, pluginId: string): Promise<string> {
	const directoryName = await manager.getPluginDirectoryName(pluginId);
	if (!directoryName) throw new Error(`No installed directory for ${pluginId}`);

	return join(serverConfig.paths.plugins, directoryName);
}

async function storedConfig(manager: PluginManager, pluginId: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(await installedDirectory(manager, pluginId), "config.json"), "utf8"));
}

/** A fresh manager instance, as after a server restart: the in-memory registry is empty. */
function restartedManager(): PluginManager {
	pluginRegistry.clear();

	return new PluginManager();
}

describe("PluginManager enable and disable", () => {
	test("disabling a plugin unloads it, and the disabled state survives a restart", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.toggle", "1.0.0"), { source: "test" });
		readControl().events.length = 0;

		await manager.setEnabled("org.reelvault.toggle", false);
		expect(readControl().events).toEqual(["unload:org.reelvault.toggle"]);
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.toggle", state: "disabled" })]);

		readControl().events.length = 0;
		const afterRestart = restartedManager();
		await afterRestart.loadPlugins();

		expect(readControl().events).toEqual([]);
		expect(afterRestart.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.toggle", state: "disabled" })]);
	});

	test("enabling a disabled plugin loads it again", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.reenable", "1.0.0"), { source: "test" });
		await manager.setEnabled("org.reelvault.reenable", false);
		readControl().events.length = 0;

		await manager.setEnabled("org.reelvault.reenable", true);

		expect(readControl().events).toEqual(["setup:org.reelvault.reenable"]);
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.reenable", state: "enabled" })]);
	});

	test("disabling a plugin that is not installed is rejected", async () => {
		const manager = new PluginManager();

		await expect(manager.setEnabled("org.reelvault.unknown", false)).rejects.toMatchObject({
			category: "validation",
			code: "plugin.not_installed",
		});
	});

	test("a plugin that is not installed is not found, and leaves no failed card behind", async () => {
		const manager = new PluginManager();

		await expect(manager.reload("org.reelvault.absent")).rejects.toMatchObject({
			category: "not_found",
			code: "plugin.not_found",
		});
		await expect(manager.setEnabled("org.reelvault.absent", true)).rejects.toMatchObject({
			category: "not_found",
			code: "plugin.not_found",
		});

		expect(manager.getStatus().filter((status) => status.id === "org.reelvault.absent")).toEqual([]);
	});

	test("disabling an already disabled plugin changes nothing", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.idempotent", "1.0.0"), { source: "test" });
		await manager.setEnabled("org.reelvault.idempotent", false);
		readControl().events.length = 0;

		await manager.setEnabled("org.reelvault.idempotent", false);

		expect(readControl().events).toEqual([]);
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.idempotent", state: "disabled" })]);
	});

	test("enabling a plugin whose setup fails leaves it failed, not disabled", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.broken", "1.0.0"), { source: "test" });
		await manager.setEnabled("org.reelvault.broken", false);
		readControl().failSetup.add("org.reelvault.broken@1.0.0");

		await expect(manager.setEnabled("org.reelvault.broken", true)).rejects.toThrow("setup failed for org.reelvault.broken@1.0.0");
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.broken", state: "failed" })]);
	});

	test("disabling a plugin whose onUnload throws still reports it disabled and surfaces the error", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.stuck", "1.0.0"), { source: "test" });
		readControl().failUnload.add("org.reelvault.stuck@1.0.0");

		await expect(manager.setEnabled("org.reelvault.stuck", false)).rejects.toThrow("onUnload failed for org.reelvault.stuck@1.0.0");
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.stuck", state: "disabled" })]);
	});

	test("reloading a disabled plugin leaves it unloaded", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.sleeping", "1.0.0"), { source: "test" });
		await manager.setEnabled("org.reelvault.sleeping", false);
		readControl().events.length = 0;

		await manager.reload("org.reelvault.sleeping");

		expect(readControl().events).toEqual([]);
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.sleeping", state: "disabled" })]);
	});

	test("uninstalling removes the package and its disabled state", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.gone", "1.0.0"), { source: "test" });
		const directory = await installedDirectory(manager, "org.reelvault.gone");
		await manager.setEnabled("org.reelvault.gone", false);

		await manager.uninstall("org.reelvault.gone");

		expect(manager.getStatus()).toEqual([]);
		expect(existsSync(directory)).toBe(false);
	});
});

describe("PluginManager startup", () => {
	test("loadPlugins loads enabled plugins and leaves disabled ones unloaded", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.on", "1.0.0"), { source: "test" });
		await manager.installFromDirectory(await writePackage("org.reelvault.off", "1.0.0"), { source: "test" });
		await manager.setEnabled("org.reelvault.off", false);

		const afterRestart = restartedManager();
		await afterRestart.loadPlugins();

		expect(afterRestart.getStatus()).toEqual([
			expect.objectContaining({ id: "org.reelvault.on", state: "enabled" }),
			expect.objectContaining({ id: "org.reelvault.off", state: "disabled" }),
		]);
	});

	test("loadPlugins shows a disabled plugin with its manifest name and the lockfile version", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.named", "3.1.0", { name: "Named fixture" }), { source: "test" });
		await manager.setEnabled("org.reelvault.named", false);

		const afterRestart = restartedManager();
		await afterRestart.loadPlugins();

		expect(afterRestart.getStatus()).toEqual([
			expect.objectContaining({ id: "org.reelvault.named", name: "Named fixture", version: "3.1.0", state: "disabled" }),
		]);
	});

	test("loadPlugins falls back to the lockfile identity when a disabled plugin's manifest is unreadable", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.unreadable", "2.4.1"), { source: "test" });
		await manager.setEnabled("org.reelvault.unreadable", false);
		const directory = await installedDirectory(manager, "org.reelvault.unreadable");
		await rm(join(directory, "plugin.json"));

		const afterRestart = restartedManager();
		await afterRestart.loadPlugins();

		expect(afterRestart.getStatus()).toEqual([
			expect.objectContaining({ id: "org.reelvault.unreadable", name: "org.reelvault.unreadable", version: "2.4.1", state: "disabled" }),
		]);
	});

	test("reloadAll unloads every plugin before loading it again", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.cycle", "1.0.0"), { source: "test" });
		readControl().events.length = 0;

		await manager.reloadAll();

		expect(readControl().events).toEqual(["unload:org.reelvault.cycle", "setup:org.reelvault.cycle"]);
	});
});

describe("PluginManager install and upgrade", () => {
	test("installing a fresh plugin activates it", async () => {
		const manager = new PluginManager();

		const result = await manager.installFromDirectory(await writePackage("org.reelvault.fresh", "1.0.0"), { source: "test" });

		expect(result).toMatchObject({
			pluginId: "org.reelvault.fresh",
			version: "1.0.0",
			direction: "install",
			state: "enabled",
			upgraded: false,
		});
		expect(readControl().events).toEqual(["setup:org.reelvault.fresh"]);
	});

	test("upgrading a disabled plugin keeps it disabled and unloaded", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.stays-off", "1.0.0"), { source: "test" });
		await manager.setEnabled("org.reelvault.stays-off", false);
		readControl().events.length = 0;

		await manager.installFromDirectory(await writePackage("org.reelvault.stays-off", "2.0.0"), { source: "test" });

		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.stays-off", version: "2.0.0", state: "disabled" })]);
		expect(readControl().events).toEqual([]);
	});

	test("upgrading an enabled plugin loads the new version", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.moving", "1.0.0"), { source: "test" });
		readControl().events.length = 0;

		await manager.installFromDirectory(await writePackage("org.reelvault.moving", "2.0.0"), { source: "test" });

		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.moving", version: "2.0.0", state: "enabled" })]);
		expect(readControl().events).toContain("setup:org.reelvault.moving");
	});

	test("an upgrade whose new version fails to load is rolled back to the previous version", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.reverted", "1.0.0"), { source: "test" });
		readControl().failSetup.add("org.reelvault.reverted@2.0.0");

		const result = await manager.installFromDirectory(await writePackage("org.reelvault.reverted", "2.0.0"), { source: "test" });

		expect(result).toMatchObject({
			pluginId: "org.reelvault.reverted",
			version: "1.0.0",
			previousVersion: "1.0.0",
			direction: "upgrade",
			state: "rolled_back",
			error: "setup failed for org.reelvault.reverted@2.0.0",
		});
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.reverted", version: "1.0.0", state: "enabled" })]);
	});

	test("enabling an upgrade that does not load restores the disabled version it replaced and keeps it disabled", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.undo", "1.0.0"), { source: "test" });
		await manager.setEnabled("org.reelvault.undo", false);
		await manager.installFromDirectory(await writePackage("org.reelvault.undo", "2.0.0"), { source: "test" });
		readControl().failSetup.add("org.reelvault.undo@2.0.0");

		await expect(manager.setEnabled("org.reelvault.undo", true)).rejects.toMatchObject({
			code: "plugin.upgrade_rolled_back",
			params: { pluginId: "org.reelvault.undo", version: "1.0.0" },
		});
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.undo", version: "1.0.0", state: "disabled" })]);
	});

	test("enabling a plugin with no upgrade to undo rethrows the load failure", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.no-undo", "1.0.0"), { source: "test" });
		await manager.setEnabled("org.reelvault.no-undo", false);
		readControl().failSetup.add("org.reelvault.no-undo@1.0.0");

		await expect(manager.setEnabled("org.reelvault.no-undo", true)).rejects.toThrow("setup failed for org.reelvault.no-undo@1.0.0");
	});
});

describe("PluginManager status and integrity", () => {
	test("getStatus lists working plugins before failed ones, whatever their names", async () => {
		const manager = new PluginManager();
		readControl().failSetup.add("org.reelvault.zz-failing@1.0.0");
		await manager.installFromDirectory(await writePackage("org.reelvault.zz-failing", "1.0.0", { name: "Aardvark" }), { source: "test" });
		await manager.installFromDirectory(await writePackage("org.reelvault.aa-working", "1.0.0", { name: "Zebra" }), { source: "test" });

		expect(manager.getStatus().map((status) => [status.id, status.state])).toEqual([
			["org.reelvault.aa-working", "enabled"],
			["org.reelvault.zz-failing", "failed"],
		]);
	});

	test("getPackageDetails reports the installed record and the declared capabilities", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.details", "3.1.0"), { source: "test" });

		await expect(manager.getPackageDetails("org.reelvault.details")).resolves.toMatchObject({
			capabilities: ["eventHandler"],
			source: "test",
			integrityOk: true,
			cspDisabled: false,
			pinned: false,
		});
	});

	test("a package edited after install is reported as not ok at the boot that notices it", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.tampered", "1.0.0"), { source: "test" });
		const directory = await installedDirectory(manager, "org.reelvault.tampered");
		await writeFile(join(directory, "index.mjs"), "export default { setup() {} };\n");

		const afterRestart = restartedManager();
		await afterRestart.loadPlugins();

		await expect(afterRestart.getPackageDetails("org.reelvault.tampered")).resolves.toMatchObject({ integrityOk: false });
	});
});

describe("PluginManager config", () => {
	test("getPluginConfigDetails infers fields from the stored values and never echoes a secret", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.infer", "3.1.0"), { source: "test" });
		await manager.savePluginConfig("org.reelvault.infer", { apiKey: "secret-value", debug: true, retries: 2, theme: "dark" });

		const details = await manager.getPluginConfigDetails("org.reelvault.infer");

		expect(details).toMatchObject({ id: "org.reelvault.infer", version: "3.1.0" });
		expect(details.config).toEqual({ debug: true, retries: 2, theme: "dark" });
		expect(details.fields).toEqual([
			{ name: "apiKey", type: "secret", label: "Api Key", hasValue: true },
			{ name: "debug", type: "boolean", label: "Debug", default: true },
			{ name: "retries", type: "number", label: "Retries", default: 2 },
			{ name: "theme", type: "string", label: "Theme", default: "dark" },
		]);
	});

	test("getPluginConfigDetails reports an unset secret as having no value", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.unset", "1.0.0"), { source: "test" });
		await manager.savePluginConfig("org.reelvault.unset", { apiKey: "   " });

		const details = await manager.getPluginConfigDetails("org.reelvault.unset");

		expect(details.fields).toEqual([{ name: "apiKey", type: "secret", label: "Api Key", hasValue: false }]);
		expect(details.config).toEqual({});
	});

	test("savePluginConfig writes the patch, reloads the plugin and returns the refreshed details", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.saved", "1.0.0"), { source: "test" });
		readControl().events.length = 0;

		const details = await manager.savePluginConfig("org.reelvault.saved", { theme: "light" });

		expect(details.config).toEqual({ theme: "light" });
		expect(await storedConfig(manager, "org.reelvault.saved")).toEqual({ theme: "light" });
		expect(readControl().events).toEqual(["unload:org.reelvault.saved", "setup:org.reelvault.saved"]);
	});

	test("savePluginConfig maps a value the plugin rejects to a validation error naming the field and writes nothing", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.locale", "1.0.0", { exportMembers: LOCALE_CONFIG }), {
			source: "test",
		});

		const failure = await manager.savePluginConfig("org.reelvault.locale", { language: "not a locale" }).catch((error: unknown) => error);

		expect(failure).toMatchObject({ category: "validation", code: "plugin.config_invalid", params: { field: "language" } });
		expect(existsSync(join(await installedDirectory(manager, "org.reelvault.locale"), "config.json"))).toBe(false);
	});

	test("savePluginConfig refuses to save a required secret that is still blank and writes nothing", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.required", "1.0.0", { exportMembers: REQUIRED_API_KEY_CONFIG }), {
			source: "test",
		});

		const failure = await manager.savePluginConfig("org.reelvault.required", { apiKey: "   " }).catch((error: unknown) => error);

		expect(failure).toMatchObject({ category: "validation", code: "plugin.config_invalid", params: { field: "apiKey" } });
		expect(existsSync(join(await installedDirectory(manager, "org.reelvault.required"), "config.json"))).toBe(false);
	});

	test("a required secret saved with a value is accepted, reported as present and never returned", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.filled", "1.0.0", { exportMembers: REQUIRED_API_KEY_CONFIG }), {
			source: "test",
		});

		await manager.savePluginConfig("org.reelvault.filled", { apiKey: "key" });

		const details = await manager.getPluginConfigDetails("org.reelvault.filled");
		expect(details.fields).toContainEqual(expect.objectContaining({ name: "apiKey", type: "secret", hasValue: true }));
		expect(details.config).not.toHaveProperty("apiKey");
	});

	test("a partial save keeps a required secret that was stored earlier", async () => {
		const manager = new PluginManager();
		await manager.installFromDirectory(await writePackage("org.reelvault.kept", "1.0.0", { exportMembers: API_KEY_AND_THEME_CONFIG }), {
			source: "test",
		});
		await manager.savePluginConfig("org.reelvault.kept", { apiKey: "stored" });

		await manager.savePluginConfig("org.reelvault.kept", { theme: "light" });

		expect(await storedConfig(manager, "org.reelvault.kept")).toEqual({ apiKey: "stored", theme: "light" });
	});
});
