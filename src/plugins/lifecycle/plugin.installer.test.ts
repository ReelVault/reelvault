import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, write } from "bun";
import { removeTree } from "@/utils/directory.utils";
import { PluginInstaller } from "./plugin.installer";

const temporaryDirectories: string[] = [];
const SHA256_INTEGRITY_REGEX = /^sha256-/;

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await removeTree(directory)));
});

describe("plugin installer", () => {
	test("installs a verified unpacked plugin atomically and records its integrity", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.installed");

		const installed = await new PluginInstaller(pluginsDirectory).install(source);

		expect(installed).toMatchObject({
			id: "org.reelvault.installed",
			directory: join(pluginsDirectory, "org.reelvault.installed"),
			record: { directory: "org.reelvault.installed", version: "1.0.0", source, integrity: expect.stringMatching(SHA256_INTEGRITY_REGEX) },
		});
		expect(await file(join(pluginsDirectory, "org.reelvault.installed", "index.mjs")).text()).toContain("setup");
		expect(await file(join(pluginsDirectory, "plugins.lock.json")).json()).toMatchObject({
			version: 1,
			plugins: { "org.reelvault.installed": { version: "1.0.0", integrity: expect.stringMatching(SHA256_INTEGRITY_REGEX) } },
		});
	});

	test("does not overwrite an installed plugin or mutate the lockfile", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.duplicate");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);
		const initialLockfile = await file(join(pluginsDirectory, "plugins.lock.json")).text();

		await expect(installer.install(source)).rejects.toMatchObject({ category: "validation", code: "plugin.already_installed" });
		expect(await file(join(pluginsDirectory, "plugins.lock.json")).text()).toBe(initialLockfile);
	});

	test("rejects invalid manifests and symbolic links before installing", async () => {
		const root = await createRoot();
		const invalidSource = join(root, "invalid");
		const linkedSource = join(root, "linked");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(invalidSource, "org.reelvault.invalid", "../escape.mjs");
		await writePlugin(linkedSource, "org.reelvault.linked");
		await symlink(join(linkedSource, "index.mjs"), join(linkedSource, "linked-entry.mjs"));
		const installer = new PluginInstaller(pluginsDirectory);

		await expect(installer.install(invalidSource)).rejects.toMatchObject({ category: "validation", code: "plugin.field_path_invalid" });
		await expect(installer.install(linkedSource)).rejects.toMatchObject({ category: "validation", code: "plugin.package_symlink_invalid" });
		expect(await file(join(pluginsDirectory, "plugins.lock.json")).exists()).toBeFalse();
	});

	test("rejects a source directory that overlaps with the plugins directory", async () => {
		const root = await createRoot();
		const pluginsDirectory = join(root, "plugins");
		const source = join(pluginsDirectory, "source");
		await writePlugin(source, "org.reelvault.overlap");

		await expect(new PluginInstaller(pluginsDirectory).install(source)).rejects.toMatchObject({
			category: "validation",
			code: "plugin.source_overlaps_plugins_directory",
		});
	});

	test("lists, verifies, and uninstalls only the plugin recorded in the lockfile", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.managed");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);

		await expect(installer.list()).resolves.toMatchObject([{ id: "org.reelvault.managed", record: { version: "1.0.0" } }]);
		await expect(installer.verify()).resolves.toHaveLength(1);
		await expect(installer.uninstall("org.reelvault.managed")).resolves.toMatchObject({ version: "1.0.0" });
		expect(await file(join(pluginsDirectory, "org.reelvault.managed")).exists()).toBeFalse();
		await expect(installer.list()).resolves.toEqual([]);
	});
});

describe("plugin installer", () => {
	test("persists the disabled flag in the lockfile and keeps the record verifiable", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.toggled");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);

		await installer.setDisabled("org.reelvault.toggled", true);
		await expect(installer.getDisabledIds()).resolves.toEqual(new Set(["org.reelvault.toggled"]));
		await expect(installer.list()).resolves.toMatchObject([{ id: "org.reelvault.toggled", record: { disabled: true } }]);
		// Integrity covers the package files, not the lockfile flag — a disabled
		// plugin must still verify.
		await expect(installer.verify()).resolves.toHaveLength(1);

		await installer.setDisabled("org.reelvault.toggled", true);
		await expect(installer.getDisabledIds()).resolves.toEqual(new Set(["org.reelvault.toggled"]));
		await installer.setDisabled("org.reelvault.toggled", false);
		await expect(installer.getDisabledIds()).resolves.toEqual(new Set());
		await expect(installer.list()).resolves.toMatchObject([{ id: "org.reelvault.toggled", record: { disabled: false } }]);

		await expect(installer.setDisabled("org.reelvault.missing", true)).rejects.toMatchObject({ code: "plugin.not_installed" });
	});

	test("detects an installed package whose content no longer matches its lockfile", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.changed");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);
		await write(join(pluginsDirectory, "org.reelvault.changed", "index.mjs"), "export default { setup() { return true; } };\n");

		await expect(installer.verify()).rejects.toMatchObject({ category: "validation", code: "plugin.integrity_mismatch" });
	});

	test("excludes the mutable admin config.json from package integrity", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.mutable-config");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);

		// config.json is admin-owned runtime state — writing it (or rotating a
		// secret in it) must not make the package look tampered with.
		await write(join(pluginsDirectory, "org.reelvault.mutable-config", "config.json"), '{"apiKey":"secret"}\n');
		await expect(installer.verify()).resolves.toHaveLength(1);
		await write(join(pluginsDirectory, "org.reelvault.mutable-config", "config.json"), '{"apiKey":"rotated"}\n');
		await expect(installer.verify()).resolves.toHaveLength(1);
	});

	test("refreshIntegrity reconciles out-of-band package changes and reports them", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.reconcile");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);
		await expect(installer.refreshIntegrity()).resolves.toEqual([]);

		await write(join(pluginsDirectory, "org.reelvault.reconcile", "index.mjs"), "export default { setup() { return 2; } };\n");
		await expect(installer.refreshIntegrity()).resolves.toEqual(["org.reelvault.reconcile"]);
		// The refreshed record makes the next boot's check clean.
		await expect(installer.verify()).resolves.toHaveLength(1);
	});
});

describe("plugin installer", () => {
	test("upgrades an installed plugin atomically and records the catalog source", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.upgrade");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);

		await write(
			join(source, "plugin.json"),
			JSON.stringify({
				id: "org.reelvault.upgrade",
				name: "org.reelvault.upgrade",
				version: "2.0.0",
				entry: "./index.mjs",
				capabilities: ["eventHandler"],
			}),
		);
		const upgraded = await installer.install(source, { upgrade: true, source: "catalog:repo:org.reelvault.upgrade@2.0.0" });

		expect(upgraded.record).toMatchObject({ version: "2.0.0", source: "catalog:repo:org.reelvault.upgrade@2.0.0" });
		expect(await file(join(pluginsDirectory, "plugins.lock.json")).json()).toMatchObject({
			version: 1,
			plugins: { "org.reelvault.upgrade": { version: "2.0.0" } },
		});
		await expect(installer.verify()).resolves.toHaveLength(1);
		expect(await file(join(pluginsDirectory, "org.reelvault.upgrade", "plugin.json")).json()).toMatchObject({ version: "2.0.0" });
		// The replaced package is kept as the rollback point until the upgrade is confirmed.
		expect(await file(join(pluginsDirectory, "plugins.lock.json")).json()).toMatchObject({
			plugins: { "org.reelvault.upgrade": { previous: { version: "1.0.0" } } },
		});
		expect(await backupDirectories(pluginsDirectory)).toHaveLength(1);
	});

	test("keeps the admin config.json on uninstall and restores it when the plugin is installed again", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.reinstall");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);
		await write(join(pluginsDirectory, "org.reelvault.reinstall", "config.json"), '{"apiKey":"secret"}\n');

		await installer.uninstall("org.reelvault.reinstall");
		expect(await file(join(pluginsDirectory, ".config-backups", "org.reelvault.reinstall.json")).json()).toEqual({ apiKey: "secret" });

		await installer.install(source);

		expect(await file(join(pluginsDirectory, "org.reelvault.reinstall", "config.json")).json()).toEqual({ apiKey: "secret" });
		expect(await file(join(pluginsDirectory, ".config-backups", "org.reelvault.reinstall.json")).exists()).toBe(false);
	});

	test("preserves an admin config.json across a same-version upgrade", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.config");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);
		await write(join(pluginsDirectory, "org.reelvault.config", "config.json"), '{"apiKey":"secret"}\n');

		// Same version, new build — the admin config must survive the directory swap.
		await write(join(source, "index.mjs"), "export default { setup() { return 2; } };\n");
		await installer.install(source, { upgrade: true });

		expect(await file(join(pluginsDirectory, "org.reelvault.config", "config.json")).json()).toEqual({ apiKey: "secret" });
		expect(await file(join(pluginsDirectory, "org.reelvault.config", "index.mjs")).text()).toContain("return 2");
	});
});

describe("plugin installer", () => {
	test("rolls back the previous installation when an upgrade fails", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.rollback");
		const installer = new PluginInstaller(pluginsDirectory);
		const initialInstall = await installer.install(source);

		// A symlink in the staging copy fails the post-copy safety net mid-upgrade.
		await write(
			join(source, "plugin.json"),
			JSON.stringify({
				id: "org.reelvault.rollback",
				name: "org.reelvault.rollback",
				version: "2.0.0",
				entry: "./index.mjs",
				capabilities: ["eventHandler"],
			}),
		);
		await symlink(join(source, "plugin.json"), join(source, "linked.mjs"));

		await expect(installer.install(source, { upgrade: true })).rejects.toMatchObject({
			category: "validation",
			code: "plugin.package_symlink_invalid",
		});
		const lockfile = await file(join(pluginsDirectory, "plugins.lock.json")).json();
		expect(lockfile.plugins["org.reelvault.rollback"]).toMatchObject({ version: initialInstall.record.version });
		expect(await file(join(pluginsDirectory, "org.reelvault.rollback", "plugin.json")).json()).toMatchObject({ version: "1.0.0" });
	});
	test("upgrades a manually named directory in place instead of creating a second one", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.manual");

		// Manually dropped package: directory name differs from the manifest id.
		const manualDirectory = join(pluginsDirectory, "manual-name");
		await mkdir(manualDirectory, { recursive: true });
		await write(
			join(manualDirectory, "plugin.json"),
			JSON.stringify({
				id: "org.reelvault.manual",
				name: "Manual",
				version: "0.9.0",
				entry: "./index.mjs",
				capabilities: ["eventHandler"],
			}),
		);
		await write(join(manualDirectory, "index.mjs"), "export default { setup() {} };\n");

		const installer = new PluginInstaller(pluginsDirectory);
		const installed = await installer.install(source, { upgrade: true });

		expect(installed.directory).toBe(manualDirectory);
		expect(await file(join(manualDirectory, "plugin.json")).json()).toMatchObject({ version: "1.0.0" });
		// No second directory for the same id.
		expect(await file(join(pluginsDirectory, "org.reelvault.manual")).exists()).toBeFalse();
		expect(await file(join(pluginsDirectory, "plugins.lock.json")).json()).toMatchObject({
			plugins: { "org.reelvault.manual": { directory: "manual-name", version: "1.0.0" } },
		});
		// The differently-named record still verifies and uninstalls.
		await expect(installer.verify()).resolves.toHaveLength(1);
		await installer.uninstall("org.reelvault.manual");
		expect(await file(manualDirectory).exists()).toBeFalse();
	});

	test("refuses a non-upgrade install when the id lives in a differently named directory", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.manual-guard");
		const manualDirectory = join(pluginsDirectory, "manual-guard");
		await writePlugin(manualDirectory, "org.reelvault.manual-guard");

		await expect(new PluginInstaller(pluginsDirectory).install(source)).rejects.toMatchObject({
			category: "validation",
			code: "plugin.already_installed",
		});
		expect(await file(join(manualDirectory, "plugin.json")).exists()).toBeTrue();
		expect(await file(join(pluginsDirectory, "org.reelvault.manual-guard")).exists()).toBeFalse();
	});

	test("removes a stale duplicate directory carrying the same plugin id", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.dedupe");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);

		const duplicate = join(pluginsDirectory, "stale-duplicate");
		await writePlugin(duplicate, "org.reelvault.dedupe");

		await installer.install(source, { upgrade: true });

		expect(await file(duplicate).exists()).toBeFalse();
		expect(await file(join(pluginsDirectory, "org.reelvault.dedupe", "plugin.json")).exists()).toBeTrue();
	});
});

async function createRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "reelvault-plugin-installer-"));
	temporaryDirectories.push(root);

	return root;
}

async function writePlugin(directory: string, id: string, entry = "./index.mjs"): Promise<void> {
	await mkdir(directory, { recursive: true });
	await write(
		join(directory, "plugin.json"),
		JSON.stringify({
			id,
			name: id,
			version: "1.0.0",
			entry,
			capabilities: ["eventHandler"],
		}),
	);
	await write(join(directory, "index.mjs"), "export default { setup() {} };\n");
}

describe("plugin installer rollback point", () => {
	test("keeps the replaced package until the upgrade is confirmed, then removes it", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		const installer = new PluginInstaller(pluginsDirectory);
		await writePlugin(source, "org.reelvault.confirm");
		await installer.install(source);
		await writeVersion(source, "org.reelvault.confirm", "2.0.0");
		await installer.install(source, { upgrade: true });

		expect(await backupDirectories(pluginsDirectory)).toHaveLength(1);
		await expect(installer.confirmUpgrade("org.reelvault.confirm")).resolves.toBe(true);
		expect(await backupDirectories(pluginsDirectory)).toEqual([]);
		expect(await file(join(pluginsDirectory, "plugins.lock.json")).json()).toMatchObject({
			plugins: { "org.reelvault.confirm": { version: "2.0.0" } },
		});
		await expect(installer.confirmUpgrade("org.reelvault.confirm")).resolves.toBe(false);
	});

	test("rolls back to the replaced package and keeps the configuration saved after the upgrade", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		const installer = new PluginInstaller(pluginsDirectory);
		await writePlugin(source, "org.reelvault.rollback");
		await installer.install(source);
		await writeVersion(source, "org.reelvault.rollback", "2.0.0");
		await installer.install(source, { upgrade: true });
		await write(join(pluginsDirectory, "org.reelvault.rollback", "config.json"), JSON.stringify({ apiKey: "saved-after-upgrade" }));

		const restored = await installer.rollbackUpgrade("org.reelvault.rollback");

		expect(restored).toMatchObject({ version: "1.0.0", directory: "org.reelvault.rollback" });
		expect(restored?.previous).toBeUndefined();
		expect(await file(join(pluginsDirectory, "org.reelvault.rollback", "plugin.json")).json()).toMatchObject({ version: "1.0.0" });
		expect(await file(join(pluginsDirectory, "org.reelvault.rollback", "config.json")).json()).toEqual({ apiKey: "saved-after-upgrade" });
		expect(await backupDirectories(pluginsDirectory)).toEqual([]);
		await expect(installer.verify()).resolves.toHaveLength(1);
	});

	test("reports no rollback point for a plugin that was never upgraded", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const installer = new PluginInstaller(join(root, "plugins"));
		await writePlugin(source, "org.reelvault.fresh");
		await installer.install(source);

		await expect(installer.rollbackUpgrade("org.reelvault.fresh")).resolves.toBeUndefined();
		await expect(installer.confirmUpgrade("org.reelvault.fresh")).resolves.toBe(false);
	});

	test("uninstall removes the rollback point together with the package", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		const installer = new PluginInstaller(pluginsDirectory);
		await writePlugin(source, "org.reelvault.gone");
		await installer.install(source);
		await writeVersion(source, "org.reelvault.gone", "2.0.0");
		await installer.install(source, { upgrade: true });

		await installer.uninstall("org.reelvault.gone");

		expect(await backupDirectories(pluginsDirectory)).toEqual([]);
	});
});

async function writeVersion(directory: string, id: string, version: string): Promise<void> {
	await write(
		join(directory, "plugin.json"),
		JSON.stringify({ id, name: id, version, entry: "./index.mjs", capabilities: ["eventHandler"] }),
	);
}

async function backupDirectories(pluginsDirectory: string): Promise<string[]> {
	return await Array.fromAsync(new Bun.Glob(".upgrade-*").scan({ cwd: pluginsDirectory, dot: true, onlyFiles: false }));
}
