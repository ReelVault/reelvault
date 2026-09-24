import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRuntime } from "@reelvault/sdk/plugin";
import { ValidationError } from "@/utils/errors";
import { PluginManager } from "./manager/plugin-manager.service";
import type { PluginConfig } from "./plugin.config";
import type { InstalledPluginRecord, PluginInstaller } from "./plugin.installer";
import type { PluginLoader } from "./plugin.loader";
import type { PluginRegistry } from "./plugin.registry";

process.env.NODE_ENV ??= "test";
process.env.APP_PORT ??= "3030";
process.env.ROOT_DIR ??= join(tmpdir(), `reelvault-tests-${process.pid}`);

function stubMethod<TArgs extends unknown[] = unknown[]>(
	target: object,
	method: string,
	impl: (...args: TArgs) => unknown,
): { calls: TArgs[]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: TArgs[] = [];
	const replacement = (...args: TArgs) => {
		calls.push(args);

		return impl(...args);
	};
	Reflect.set(target, method, replacement);

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

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
		stubMethod(loader, "loadAll", () => Promise.resolve()),
		stubMethod(loader, "load", () => Promise.resolve()),
		stubMethod(loader, "unloadPlugin", () => Promise.resolve()),
		stubMethod(loader, "unloadAll", () => Promise.resolve()),
		stubMethod(loader, "reloadPlugin", () => Promise.resolve()),
		stubMethod(loader, "uninstallPlugin", () => Promise.resolve()),
		stubMethod(loader, "findDirectoryNameForPluginId", (pluginId: string) =>
			Promise.resolve(pluginId === "org.reelvault.m" ? "m-dir" : undefined),
		),
	);

	return { manager, loader, installer, config, registry };
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
		const { registry } = createManagerFixture([]);
		registry.clear();
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

	test("installFromDirectory clears the disabled status of a reinstalled plugin", async () => {
		const { manager, loader, installer, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		stubUnloadThroughRegistry(activeStubs, loader, registry);
		await manager.setEnabled("org.reelvault.m", false);
		const installStub = stubMethod(installer, "install", () =>
			Promise.resolve({ id: "org.reelvault.m", directory: "/plugins/m", record: {} }),
		);
		activeStubs.push(installStub);

		await manager.installFromDirectory("/sources/m", {});

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

	test("uninstall removes loaded data and tolerates a missing installer record", async () => {
		const { manager, loader, installer } = createManagerFixture(activeStubs);
		const calls: string[] = [];
		const loaderStub = stubMethod(loader, "uninstallPlugin", (pluginId: string) => {
			calls.push(`loader:${pluginId}`);

			return Promise.resolve();
		});
		const installerStub = stubMethod(installer, "uninstall", () => {
			calls.push("installer");

			return Promise.reject(new ValidationError("not installed"));
		});
		activeStubs.push(loaderStub, installerStub);

		await manager.uninstall("org.reelvault.m");
		expect(calls).toEqual(["loader:org.reelvault.m", "installer"]);
	});

	test("uninstall rethrows unexpected installer failures", async () => {
		const { manager, installer } = createManagerFixture(activeStubs);
		const failingStub = stubMethod(installer, "uninstall", () => Promise.reject(new Error("disk on fire")));
		activeStubs.push(failingStub);

		await expect(manager.uninstall("org.reelvault.m")).rejects.toThrow("disk on fire");
	});

	test("installFromDirectory upgrades and reloads an already-loaded plugin, swallowing reload failures", async () => {
		const { manager, loader, installer, registry } = createManagerFixture(activeStubs);
		registry.register(createLoadedRuntime("org.reelvault.m"), []);
		const installStub = stubMethod(installer, "install", (source: string, options: Record<string, unknown>) =>
			Promise.resolve({ id: "org.reelvault.m", directory: "/plugins/m", record: {}, source, options }),
		);
		const reloadStub = stubMethod(loader, "reloadPlugin", (_pluginId: string) => Promise.reject(new Error("reload blew up")));
		activeStubs.push(installStub, reloadStub);

		const result = await manager.installFromDirectory("/sources/m", { source: "catalog:repo:org.reelvault.m@2.0.0" });

		expect(result.id).toBe("org.reelvault.m");
		expect(reloadStub.calls).toEqual([["org.reelvault.m"]]);
	});

	test("installFromDirectory skips the reload for a not-yet-loaded plugin", async () => {
		const { manager, loader, installer, registry } = createManagerFixture(activeStubs);
		const installStub = stubMethod(installer, "install", () =>
			Promise.resolve({ id: "org.reelvault.fresh", directory: "/plugins/fresh", record: {} }),
		);
		const reloadStub = stubMethod(loader, "reloadPlugin", (_pluginId: string) => Promise.resolve());
		activeStubs.push(installStub, reloadStub);

		await manager.installFromDirectory("/sources/new", {});

		expect(registry.get("org.reelvault.fresh")).toBeUndefined();
		expect(reloadStub.calls).toEqual([]);
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
		const { registry } = createManagerFixture([]);
		registry.clear();
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
			{ name: "apiKey", type: "secret", label: "Api Key" },
			{ name: "debug", type: "boolean", label: "Debug", default: true },
			{ name: "retries", type: "number", label: "Retries", default: 2 },
			{ name: "theme", type: "string", label: "Theme", default: "dark" },
		]);
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

		expect(saveStub.calls).toEqual([["m-dir", { theme: "light" }]]);
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
});
