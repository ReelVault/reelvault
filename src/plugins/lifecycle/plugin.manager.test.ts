import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRuntime } from "@reelvault/sdk/plugin";
import { ValidationError } from "@/utils/errors";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { PluginManager } from "./manager/plugin-manager.service";
import type { PluginConfig } from "./plugin.config";
import type { InstalledPluginRecord, PluginInstaller } from "./plugin.installer";
import type { PluginLoader } from "./plugin.loader";
import { type PluginRegistry, pluginRegistry } from "./plugin.registry";
import { pluginUiSettingsService } from "./plugin-ui-settings.service";

process.env.NODE_ENV ??= "test";
process.env.APP_PORT ??= "3030";
process.env.ROOT_DIR ??= join(tmpdir(), `reelvault-tests-${process.pid}`);

function createManagerFixture(activeStubs: Array<{ restore(): void }>) {
	const manager = new PluginManager();
	const loader: PluginLoader = Reflect.get(manager, "loader");
	const installer: PluginInstaller = Reflect.get(manager, "installer");
	const config: PluginConfig = Reflect.get(manager, "config");
	const registry: PluginRegistry = Reflect.get(manager, "registry");
	activeStubs.push(
		stubMethod(installer, "refreshIntegrity", () => Promise.resolve([])),
		stubMethod(installer, "setDisabled", () => Promise.resolve()),
		stubMethod(installer, "uninstall", () => Promise.resolve({})),
		stubMethod(installer, "list", () => Promise.resolve([])),
		stubMethod(installer, "confirmUpgrade", () => Promise.resolve(false)),
		stubMethod(installer, "rollbackUpgrade", () => Promise.resolve(undefined)),
		stubMethod(loader, "loadAll", () => Promise.resolve()),
		stubMethod(loader, "load", () => Promise.resolve()),
		stubMethod(loader, "unloadPlugin", () => Promise.resolve()),
		stubMethod(loader, "unloadAll", () => Promise.resolve()),
		stubMethod(loader, "reloadPlugin", () => Promise.resolve()),
		stubMethod(loader, "prepareUninstall", () => Promise.resolve()),
		stubMethod(loader, "removePluginData", () => Promise.resolve()),
		stubMethod(pluginUiSettingsService, "reset", () => Promise.resolve()),
		stubMethod(loader, "findDirectoryNameForPluginId", (pluginId: string) =>
			Promise.resolve(pluginId === "org.reelvault.m" ? "m-dir" : undefined),
		),
	);

	return { manager, loader, installer, config, registry };
}

/** A lockfile entry whose directory is the plugin id's last segment, mirroring the fixture plugin. */
function installedRecord(id: string, version: string): { id: string; record: InstalledPluginRecord } {
	return {
		id,
		record: {
			directory: id.split(".").at(-1) ?? id,
			integrity: "sha256-test",
			installedAt: "2026-10-09T10:00:00.000Z",
			source: "upload",
			version,
		},
	};
}

function createLoadedRuntime(id: string): PluginRuntime {
	return {
		manifest: { id, name: id, version: "1.0.0", entry: "./index.mjs", capabilities: ["eventHandler"] },
		plugin: { setup: async () => undefined },
		state: "discovered",
		providerIds: [],
		subtitleProviderIds: [],
		analyzerIds: [],
		jobNames: [],
	};
}

const temporaryDirectories: string[] = [];

async function writeFixturePlugin(): Promise<void> {
	const { serverConfig } = await import("@/server.config");
	const pluginDirectory = join(serverConfig.paths.plugins, "m-dir");
	await mkdir(pluginDirectory, { recursive: true });
	await writeFile(
		join(pluginDirectory, "plugin.json"),
		JSON.stringify({
			id: "org.reelvault.m",
			name: "Manager fixture",
			version: "3.1.0",
			entry: "./index.mjs",
			capabilities: ["eventHandler"],
		}),
	);
}

/** Mirrors the real loader: unloading removes the runtime from the registry. */
function stubUnloadThroughRegistry(activeStubs: Array<{ restore(): void }>, loader: PluginLoader, registry: PluginRegistry): void {
	activeStubs.push(
		stubMethod(loader, "unloadPlugin", (pluginId: string) => {
			registry.unregister(pluginId);

			return Promise.resolve();
		}),
	);
}

describe("PluginManager lifecycle orchestration", () => {
	let activeStubs: Array<{ restore(): void }> = [];

	beforeEach(() => {
		activeStubs = [];
	});

	afterEach(async () => {
		for (const stub of activeStubs.toReversed()) stub.restore();

		activeStubs = [];
		pluginRegistry.clear();
		await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
	});

	test("loadPlugins verifies integrity first, tolerating a failed check", async () => {
		const { manager, loader, installer } = createManagerFixture(activeStubs);
		const calls: string[] = [];
		const verifyStub = stubMethod(installer, "refreshIntegrity", () => {
			calls.push("verify");

			return Promise.resolve([]);
		});
		const loadAllStub = stubMethod(loader, "loadAll", () => {
			calls.push("loadAll");

			return Promise.resolve();
		});
		activeStubs.push(verifyStub, loadAllStub);

		await manager.loadPlugins();
		expect(calls).toEqual(["verify", "loadAll"]);

		calls.length = 0;
		const failingVerify = stubMethod(installer, "refreshIntegrity", () => {
			calls.push("verify");

			return Promise.reject(new Error("lockfile corrupt"));
		});
		activeStubs.push(failingVerify);

		await manager.loadPlugins();
		expect(calls).toEqual(["verify", "loadAll"]);
	});

	test("setEnabled persists the flag before loading or unloading", async () => {
		const { manager, loader, installer, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		const calls: string[] = [];
		const setDisabledStub = stubMethod(installer, "setDisabled", (_pluginId: string, disabled: boolean) => {
			calls.push(`setDisabled:${disabled}`);

			return Promise.resolve();
		});
		const findStub = stubMethod(loader, "findDirectoryNameForPluginId", () => Promise.resolve("m-dir"));
		const loadStub = stubMethod(loader, "load", (dirName: string) => {
			calls.push(`load:${dirName}`);

			return Promise.resolve();
		});
		const unloadStub = stubMethod(loader, "unloadPlugin", (pluginId: string) => {
			calls.push(`unload:${pluginId}`);

			return Promise.resolve();
		});
		activeStubs.push(setDisabledStub, findStub, loadStub, unloadStub);

		await manager.setEnabled("org.reelvault.m", true);
		expect(calls).toEqual(["setDisabled:false", "load:m-dir"]);

		calls.length = 0;
		await manager.setEnabled("org.reelvault.m", false);
		expect(calls).toEqual(["setDisabled:true", "unload:org.reelvault.m"]);
	});

	test("setEnabled still loads when the plugin has no lockfile record", async () => {
		const { manager, loader, installer } = createManagerFixture(activeStubs);
		const calls: string[] = [];
		const setDisabledStub = stubMethod(installer, "setDisabled", () => {
			calls.push("setDisabled");

			return Promise.reject(new Error("not installed"));
		});
		const findStub = stubMethod(loader, "findDirectoryNameForPluginId", () => Promise.resolve("m-dir"));
		const loadStub = stubMethod(loader, "load", (dirName: string) => {
			calls.push(`load:${dirName}`);

			return Promise.resolve();
		});
		activeStubs.push(setDisabledStub, findStub, loadStub);

		await manager.setEnabled("org.reelvault.m", true);
		expect(calls).toEqual(["setDisabled", "load:m-dir"]);
	});

	test("disable captures the runtime status and exposes it as disabled", async () => {
		const { manager, loader, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		registry.enable("org.reelvault.m");
		stubUnloadThroughRegistry(activeStubs, loader, registry);

		await manager.setEnabled("org.reelvault.m", false);

		expect(manager.getStatus()).toEqual([
			expect.objectContaining({
				id: "org.reelvault.m",
				name: "org.reelvault.m",
				state: "disabled",
				providers: 0,
				subtitleProviders: 0,
				jobs: 0,
			}),
		]);
	});

	test("disable of an unknown plugin is rejected", async () => {
		const { manager } = createManagerFixture(activeStubs);

		await expect(manager.setEnabled("org.reelvault.unknown", false)).rejects.toThrow("is not installed");
	});

	test("disable stays idempotent for an already-disabled plugin", async () => {
		const { manager, loader, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		stubUnloadThroughRegistry(activeStubs, loader, registry);
		await manager.setEnabled("org.reelvault.m", false);

		await manager.setEnabled("org.reelvault.m", false);

		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.m", state: "disabled" })]);
	});

	test("enable clears the disabled status even when loading fails", async () => {
		const { manager, loader, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		stubUnloadThroughRegistry(activeStubs, loader, registry);
		await manager.setEnabled("org.reelvault.m", false);
		const failingLoad = stubMethod(loader, "load", () => Promise.reject(new Error("broken build")));
		activeStubs.push(failingLoad);

		await expect(manager.setEnabled("org.reelvault.m", true)).rejects.toThrow("broken build");
		expect(manager.getStatus()).toEqual([]);
	});

	test("disable records the disabled status even when unloading throws", async () => {
		const { manager, loader, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		activeStubs.push(
			stubMethod(loader, "unloadPlugin", (pluginId: string) => {
				registry.unregister(pluginId);

				return Promise.reject(new Error("onDisable blew up"));
			}),
		);

		await expect(manager.setEnabled("org.reelvault.m", false)).rejects.toThrow("onDisable blew up");
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.m", state: "disabled" })]);
	});

	test("reload leaves disabled plugins unloaded", async () => {
		const { manager, loader, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		stubUnloadThroughRegistry(activeStubs, loader, registry);
		await manager.setEnabled("org.reelvault.m", false);
		const reloadStub = stubMethod(loader, "reloadPlugin", (_pluginId: string) => Promise.resolve());
		activeStubs.push(reloadStub);

		await manager.reload("org.reelvault.m");

		expect(reloadStub.calls).toEqual([]);
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.m", state: "disabled" })]);
	});

	test("uninstall removes the disabled status", async () => {
		const { manager, loader, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		stubUnloadThroughRegistry(activeStubs, loader, registry);
		await manager.setEnabled("org.reelvault.m", false);

		await manager.uninstall("org.reelvault.m");

		expect(manager.getStatus()).toEqual([]);
	});

	test("installFromDirectory keeps a disabled plugin disabled when it is upgraded", async () => {
		const { manager, installer } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		const record: InstalledPluginRecord = {
			directory: "m-dir",
			integrity: "sha256-x",
			installedAt: "2026-09-20T00:00:00.000Z",
			source: "fixture",
			version: "1.0.0",
			disabled: true,
		};
		const setDisabled = stubMethod(installer, "setDisabled", () => Promise.resolve());
		activeStubs.push(
			stubMethod(installer, "list", () => Promise.resolve([{ id: "org.reelvault.m", record }])),
			stubMethod(installer, "install", () =>
				Promise.resolve({ id: "org.reelvault.m", directory: "/plugins/m", record: installedRecord("org.reelvault.m", "2.0.0").record }),
			),
			setDisabled,
		);

		await manager.installFromDirectory("/sources/m", {});

		expect(setDisabled.calls).toEqual([["org.reelvault.m", true]]);
		expect(manager.getStatus()).toEqual([expect.objectContaining({ id: "org.reelvault.m", state: "disabled" })]);
	});

	test("installFromDirectory leaves a previously enabled plugin enabled", async () => {
		const { manager, installer } = createManagerFixture(activeStubs);
		const setDisabled = stubMethod(installer, "setDisabled", () => Promise.resolve());
		activeStubs.push(
			stubMethod(installer, "install", () => Promise.resolve({ id: "org.reelvault.m", directory: "/plugins/m", record: {} })),
			setDisabled,
		);

		await manager.installFromDirectory("/sources/m", {});

		expect(setDisabled.calls).toEqual([]);
		expect(manager.getStatus()).toEqual([]);
	});

	test("loadPlugins seeds disabled statuses from the lockfile", async () => {
		const { manager, installer } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		const record: InstalledPluginRecord = {
			directory: "m-dir",
			integrity: "sha256-x",
			installedAt: "2026-09-20T00:00:00.000Z",
			source: "fixture",
			version: "1.0.0",
			disabled: true,
		};
		const listStub = stubMethod(installer, "list", () => Promise.resolve([{ id: "org.reelvault.m", record }]));
		activeStubs.push(listStub);

		await manager.loadPlugins();

		expect(manager.getStatus()).toEqual([
			expect.objectContaining({ id: "org.reelvault.m", name: "Manager fixture", version: "3.1.0", state: "disabled" }),
		]);
	});

	test("loadPlugins falls back to the lockfile identity when a disabled manifest is unreadable", async () => {
		const { manager, installer } = createManagerFixture(activeStubs);
		const record: InstalledPluginRecord = {
			directory: "missing-dir",
			integrity: "sha256-x",
			installedAt: "2026-09-20T00:00:00.000Z",
			source: "fixture",
			version: "2.4.1",
			disabled: true,
		};
		const listStub = stubMethod(installer, "list", () => Promise.resolve([{ id: "org.reelvault.gone", record }]));
		activeStubs.push(listStub);

		await manager.loadPlugins();

		expect(manager.getStatus()).toEqual([
			expect.objectContaining({ id: "org.reelvault.gone", name: "org.reelvault.gone", version: "2.4.1", state: "disabled" }),
		]);
	});

	test("reloadAll unloads everything before loading again", async () => {
		const { manager, loader } = createManagerFixture(activeStubs);
		const calls: string[] = [];
		const unloadAllStub = stubMethod(loader, "unloadAll", () => {
			calls.push("unloadAll");

			return Promise.resolve();
		});
		const loadAllStub = stubMethod(loader, "loadAll", () => {
			calls.push("loadAll");

			return Promise.resolve();
		});
		activeStubs.push(unloadAllStub, loadAllStub);

		await manager.reloadAll();
		expect(calls).toEqual(["unloadAll", "loadAll"]);
	});

	test("getPluginDirectoryName resolves through the loader index", async () => {
		const { manager } = createManagerFixture(activeStubs);

		await expect(manager.getPluginDirectoryName("org.reelvault.m")).resolves.toBe("m-dir");
		await expect(manager.getPluginDirectoryName("org.reelvault.unknown")).resolves.toBeUndefined();
	});

	test("uninstall removes the package before the plugin data and tolerates a missing installer record", async () => {
		const { manager, loader, installer } = createManagerFixture(activeStubs);
		const calls: string[] = [];
		const prepareStub = stubMethod(loader, "prepareUninstall", (pluginId: string) => {
			calls.push(`prepare:${pluginId}`);

			return Promise.resolve();
		});
		const removeDataStub = stubMethod(loader, "removePluginData", (pluginId: string) => {
			calls.push(`removeData:${pluginId}`);

			return Promise.resolve();
		});
		const installerStub = stubMethod(installer, "uninstall", () => {
			calls.push("installer");

			return Promise.reject(new ValidationError("not installed"));
		});
		activeStubs.push(prepareStub, removeDataStub, installerStub);

		await manager.uninstall("org.reelvault.m");
		expect(calls).toEqual(["prepare:org.reelvault.m", "installer", "removeData:org.reelvault.m"]);
	});

	test("uninstall rethrows unexpected installer failures without touching plugin data", async () => {
		const { manager, loader, installer } = createManagerFixture(activeStubs);
		const failingStub = stubMethod(installer, "uninstall", () => Promise.reject(new Error("disk on fire")));
		const removeDataStub = stubMethod(loader, "removePluginData", () => Promise.resolve());
		activeStubs.push(failingStub, removeDataStub);

		await expect(manager.uninstall("org.reelvault.m")).rejects.toThrow("disk on fire");
		// The package is still installed, so its data must survive the failure.
		expect(removeDataStub.calls).toEqual([]);
	});

	test("installFromDirectory reports a reloaded upgrade that fails as failed when nothing can be rolled back", async () => {
		const { manager, loader, installer, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		activeStubs.push(
			stubMethod(installer, "list", () => Promise.resolve([installedRecord("org.reelvault.m", "1.0.0")])),
			stubMethod(installer, "install", () =>
				Promise.resolve({ id: "org.reelvault.m", directory: "/plugins/m", record: installedRecord("org.reelvault.m", "2.0.0").record }),
			),
			stubMethod(loader, "reloadPlugin", () => Promise.reject(new Error("reload blew up"))),
		);

		const result = await manager.installFromDirectory("/sources/m", { source: "catalog:repo:org.reelvault.m@2.0.0" });

		expect(result).toMatchObject({
			pluginId: "org.reelvault.m",
			version: "2.0.0",
			previousVersion: "1.0.0",
			direction: "upgrade",
			state: "failed",
			error: "reload blew up",
			errorCode: "plugin.load_failed",
		});
	});

	test("installFromDirectory rolls an upgrade back when the new version does not load", async () => {
		const { manager, loader, installer, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		const loadStub = stubMethod(loader, "load", () => Promise.resolve());
		const rollbackStub = stubMethod(installer, "rollbackUpgrade", () =>
			Promise.resolve(installedRecord("org.reelvault.m", "1.0.0").record),
		);
		activeStubs.push(
			stubMethod(installer, "list", () => Promise.resolve([installedRecord("org.reelvault.m", "1.0.0")])),
			stubMethod(installer, "install", () =>
				Promise.resolve({ id: "org.reelvault.m", directory: "/plugins/m", record: installedRecord("org.reelvault.m", "2.0.0").record }),
			),
			stubMethod(loader, "reloadPlugin", () => Promise.reject(new Error("bad entry"))),
			loadStub,
			rollbackStub,
		);

		const result = await manager.installFromDirectory("/sources/m", {});

		expect(result).toMatchObject({
			version: "1.0.0",
			previousVersion: "1.0.0",
			direction: "upgrade",
			state: "rolled_back",
			error: "bad entry",
		});
		expect(rollbackStub.calls).toEqual([["org.reelvault.m"]]);
		expect(loadStub.calls).toEqual([["m"]]);
	});

	test("enabling an upgrade that does not load rolls back to the previous version", async () => {
		const { manager, loader, installer } = createManagerFixture(activeStubs);
		let attempts = 0;
		const loadStub = stubMethod(loader, "load", () => {
			attempts += 1;

			return attempts === 1 ? Promise.reject(new Error("new build is broken")) : Promise.resolve();
		});
		const rollbackStub = stubMethod(installer, "rollbackUpgrade", () =>
			Promise.resolve({
				directory: "m-dir",
				integrity: "sha256-old",
				installedAt: "2026-09-20T00:00:00.000Z",
				source: "upload",
				version: "1.0.0",
			}),
		);
		activeStubs.push(loadStub, rollbackStub);

		await expect(manager.setEnabled("org.reelvault.m", true)).rejects.toMatchObject({
			code: "plugin.upgrade_rolled_back",
			params: { pluginId: "org.reelvault.m", version: "1.0.0" },
		});
		expect(rollbackStub.calls).toEqual([["org.reelvault.m"]]);
		expect(loadStub.calls).toEqual([["m-dir"], ["m-dir"]]);
	});

	test("enabling a plugin without an upgrade to undo rethrows the load failure", async () => {
		const { manager, loader } = createManagerFixture(activeStubs);
		activeStubs.push(stubMethod(loader, "load", () => Promise.reject(new Error("broken"))));

		await expect(manager.setEnabled("org.reelvault.m", true)).rejects.toThrow("broken");
	});

	test("installFromDirectory activates a fresh install", async () => {
		const { manager, loader, installer, registry } = createManagerFixture(activeStubs);
		const loadStub = stubMethod(loader, "load", () => Promise.resolve());
		activeStubs.push(
			stubMethod(installer, "install", () =>
				Promise.resolve({
					id: "org.reelvault.fresh",
					directory: "/plugins/fresh",
					record: installedRecord("org.reelvault.fresh", "1.0.0").record,
				}),
			),
			loadStub,
		);

		const result = await manager.installFromDirectory("/sources/new", {});

		expect(result).toMatchObject({
			pluginId: "org.reelvault.fresh",
			version: "1.0.0",
			direction: "install",
			state: "enabled",
			upgraded: false,
		});
		expect(loadStub.calls).toEqual([["fresh"]]);
		expect(registry.get("org.reelvault.fresh")).toBeUndefined();
	});

	test("getStatus merges live and failed plugin statuses", () => {
		const { manager, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.ok"), []);
		registry.enable("org.reelvault.ok");
		registry.register(createLoadedRuntime("org.reelvault.aaa"), []);
		registry.enable("org.reelvault.aaa");
		registry.recordFailure({ id: "org.reelvault.bad", name: "bad", version: "1.0.0" }, new Error("boom"));
		registry.recordFailure({ id: "org.reelvault.worse", name: "aardvark", version: "1.0.0" }, new Error("boom"));

		// Working plugins first, failed ones trailing — alphabetical within each group.
		expect(manager.getStatus()).toEqual([
			expect.objectContaining({ id: "org.reelvault.aaa", state: "enabled" }),
			expect.objectContaining({ id: "org.reelvault.ok", state: "enabled" }),
			expect.objectContaining({ id: "org.reelvault.worse", state: "failed", error: "boom" }),
			expect.objectContaining({ id: "org.reelvault.bad", state: "failed", error: "boom" }),
		]);
	});

	test("getInstalledRecords delegates to the installer lockfile listing", async () => {
		const { manager, installer } = createManagerFixture(activeStubs);
		const record: InstalledPluginRecord = {
			directory: "org.reelvault.m",
			integrity: "sha256-x",
			installedAt: "2026-09-20T00:00:00.000Z",
			source: "fixture",
			version: "1.0.0",
		};
		const listStub = stubMethod(installer, "list", () => Promise.resolve([{ id: "org.reelvault.m", record }]));
		activeStubs.push(listStub);

		await expect(manager.getInstalledRecords()).resolves.toEqual([{ id: "org.reelvault.m", record }]);
	});
});

describe("PluginManager config details", () => {
	let activeStubs: Array<{ restore(): void }> = [];

	beforeEach(() => {
		activeStubs = [];
	});

	afterEach(async () => {
		for (const stub of activeStubs.toReversed()) stub.restore();

		activeStubs = [];
		pluginRegistry.clear();
		await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
	});

	test("getPluginConfigDetails infers fields, redacts secrets, and never echoes secret defaults", async () => {
		const { manager, config } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		const loadStub = stubMethod(config, "load", () => Promise.resolve({ apiKey: "secret-value", debug: true, retries: 2, theme: "dark" }));
		activeStubs.push(loadStub);

		const details = await manager.getPluginConfigDetails("org.reelvault.m");

		expect(details).toMatchObject({ id: "org.reelvault.m", name: "Manager fixture", version: "3.1.0" });
		expect(details.config).toEqual({ debug: true, retries: 2, theme: "dark" });
		expect(details.fields).toEqual([
			{ name: "apiKey", type: "secret", label: "Api Key", hasValue: true },
			{ name: "debug", type: "boolean", label: "Debug", default: true },
			{ name: "retries", type: "number", label: "Retries", default: 2 },
			{ name: "theme", type: "string", label: "Theme", default: "dark" },
		]);
	});

	test("getPackageDetails reports the installed record and the declared capabilities", async () => {
		const { manager, installer } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		activeStubs.push(
			stubMethod(installer, "list", () =>
				Promise.resolve([
					{
						id: "org.reelvault.m",
						record: { directory: "m-dir", integrity: "abc", installedAt: "2026-10-09T10:00:00.000Z", source: "upload", version: "3.1.0" },
					},
				]),
			),
		);

		await expect(manager.getPackageDetails("org.reelvault.m")).resolves.toEqual({
			capabilities: ["eventHandler"],
			installedAt: "2026-10-09T10:00:00.000Z",
			source: "upload",
			integrityOk: true,
			cspDisabled: false,
		});
	});

	test("getPackageDetails reports a package that failed the integrity check as not ok", async () => {
		const { manager, installer } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		activeStubs.push(
			stubMethod(installer, "list", () =>
				Promise.resolve([
					{ id: "org.reelvault.m", record: { directory: "m-dir", integrity: "abc", installedAt: "x", source: "upload", version: "3.1.0" } },
				]),
			),
		);
		const integrityIssues: Set<string> = Reflect.get(manager, "integrityIssues");
		integrityIssues.add("org.reelvault.m");

		await expect(manager.getPackageDetails("org.reelvault.m")).resolves.toMatchObject({ integrityOk: false });
	});

	test("getPluginConfigDetails reports an unset secret as having no value", async () => {
		const { manager, config } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		const loadStub = stubMethod(config, "load", () => Promise.resolve({ apiKey: "   " }));
		activeStubs.push(loadStub);

		const details = await manager.getPluginConfigDetails("org.reelvault.m");

		expect(details.fields).toContainEqual({ name: "apiKey", type: "secret", label: "Api Key", hasValue: false });
	});

	test("savePluginConfig persists the patch, reloads, and returns refreshed details", async () => {
		const { manager, config, loader } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		const saveStub = stubMethod(config, "save", (_pluginName: string, _updated: Record<string, unknown>) => {
			return Promise.resolve({ theme: "light" });
		});
		const loadStub = stubMethod(config, "load", () => Promise.resolve({ theme: "dark" }));
		const reloadStub = stubMethod(loader, "reloadPlugin", (_pluginId: string) => Promise.resolve());
		activeStubs.push(saveStub, loadStub, reloadStub);

		const details = await manager.savePluginConfig("org.reelvault.m", { theme: "light" });

		expect(saveStub.calls).toEqual([["m-dir", { theme: "light" }, undefined, []]]);
		expect(details.config).toEqual({ theme: "dark" });
		expect(reloadStub.calls).toEqual([["org.reelvault.m"]]);
	});

	test("savePluginConfig maps SDK config validation failures to a ValidationError", async () => {
		const { manager, config, registry } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		const loadStub = stubMethod(config, "load", () => Promise.resolve({ language: "en-US" }));
		const definitionStub = stubMethod(registry, "getConfigDefinition", () => ({
			fields: {},
			descriptors: [],
			parse: () => {
				throw new Error("Plugin configuration 'language' does not match the expected format");
			},
		}));
		activeStubs.push(loadStub, definitionStub);

		const error = await manager.savePluginConfig("org.reelvault.m", { language: "not a locale" }).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ValidationError);
		expect(error).toMatchObject({ code: "plugin.config_invalid", params: { field: "language" } });
	});

	function stubRequiredApiKey(registry: PluginRegistry) {
		return stubMethod(registry, "getConfigDefinition", () => ({
			fields: {},
			descriptors: [{ name: "apiKey", type: "secret", label: "API key", required: true }],
			parse: (value: Record<string, unknown>) => ({ apiKey: value.apiKey ?? "" }),
		}));
	}

	test("savePluginConfig refuses to save a required field that is still blank", async () => {
		const { manager, config, registry } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		activeStubs.push(
			stubMethod(config, "load", () => Promise.resolve({})),
			stubRequiredApiKey(registry),
		);

		const error = await manager.savePluginConfig("org.reelvault.m", { apiKey: "   " }).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ValidationError);
		expect(error).toMatchObject({ code: "plugin.config_invalid", params: { field: "apiKey" } });
	});

	test("savePluginConfig accepts the form once the required field is filled in", async () => {
		const { manager, config, registry, loader } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		const save = stubMethod(config, "save", () => Promise.resolve({ apiKey: "key" }));
		activeStubs.push(
			stubMethod(config, "load", () => Promise.resolve({})),
			stubMethod(loader, "reloadPlugin", () => Promise.resolve()),
			save,
			stubRequiredApiKey(registry),
		);

		await manager.savePluginConfig("org.reelvault.m", { apiKey: "key" });

		expect(save.calls).toHaveLength(1);
	});

	test("a stored value satisfies the requirement when the patch leaves the secret out", async () => {
		const { manager, config, registry, loader } = createManagerFixture(activeStubs);
		await writeFixturePlugin();
		const save = stubMethod(config, "save", () => Promise.resolve({}));
		activeStubs.push(
			stubMethod(config, "load", () => Promise.resolve({ apiKey: "stored" })),
			stubMethod(loader, "reloadPlugin", () => Promise.resolve()),
			save,
			stubRequiredApiKey(registry),
		);

		await manager.savePluginConfig("org.reelvault.m", { theme: "light" });

		expect(save.calls).toHaveLength(1);
	});
});
