import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, write } from "bun";
import { PluginInstaller } from "./plugin.installer";

const temporaryDirectories: string[] = [];
const SHA256_INTEGRITY_REGEX = /^sha256-/;

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
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

		await expect(installer.install(source)).rejects.toThrow("already installed");
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

		await expect(installer.install(invalidSource)).rejects.toThrow("relative path starting with './'");
		await expect(installer.install(linkedSource)).rejects.toThrow("symbolic links");
		expect(await file(join(pluginsDirectory, "plugins.lock.json")).exists()).toBeFalse();
	});

	test("rejects a source directory that overlaps with the plugins directory", async () => {
		const root = await createRoot();
		const pluginsDirectory = join(root, "plugins");
		const source = join(pluginsDirectory, "source");
		await writePlugin(source, "org.reelvault.overlap");

		await expect(new PluginInstaller(pluginsDirectory).install(source)).rejects.toThrow("must not overlap");
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

		await expect(installer.setDisabled("org.reelvault.missing", true)).rejects.toThrow("is not installed");
	});

	test("detects an installed package whose content no longer matches its lockfile", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.changed");
		const installer = new PluginInstaller(pluginsDirectory);
		await installer.install(source);
		await write(join(pluginsDirectory, "org.reelvault.changed", "index.mjs"), "export default { setup() { return true; } };\n");

		await expect(installer.verify()).rejects.toThrow("integrity does not match");
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
		const leftovers = await Array.fromAsync(new Bun.Glob(".upgrade-*").scan({ cwd: pluginsDirectory }));
		expect(leftovers).toEqual([]);
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

	test("rolls back the previous installation when an upgrade fails", async () => {
		const root = await createRoot();
		const source = join(root, "source");
		const pluginsDirectory = join(root, "plugins");
		await writePlugin(source, "org.reelvault.rollback");
		const installer = new PluginInstaller(pluginsDirectory);
		const initialLockfile = await installer.install(source);

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

		await expect(installer.install(source, { upgrade: true })).rejects.toThrow("symbolic links");
		const lockfile = await file(join(pluginsDirectory, "plugins.lock.json")).json();
		expect(lockfile.plugins["org.reelvault.rollback"]).toMatchObject({ version: initialLockfile.record.version });
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

		await expect(new PluginInstaller(pluginsDirectory).install(source)).rejects.toThrow("already installed");
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
