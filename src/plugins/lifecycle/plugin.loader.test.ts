import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { namespacePluginJobName } from "@/plugins/capabilities/plugin.jobs";
import type { PluginConfig } from "./plugin.config";
import { PluginLoader } from "./plugin.loader";
import { PluginRegistry } from "./plugin.registry";

const lifecycleKey = "__reelvaultPluginLifecycle";
const reloadKey = "__reelvaultPluginReload";
const failUnloadKey = "__reelvaultPluginFailUnload";
const analyzerDisposeKey = "__reelvaultPluginAnalyzerDispose";
const temporaryDirectories: string[] = [];

afterEach(async () => {
	Reflect.deleteProperty(globalThis, lifecycleKey);
	Reflect.deleteProperty(globalThis, reloadKey);
	Reflect.deleteProperty(globalThis, failUnloadKey);
	Reflect.deleteProperty(globalThis, analyzerDisposeKey);
	(globalThis as Record<string, unknown>).__reelvaultPluginDisableFails = undefined;
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("plugin job names", () => {
	test("namespaces a local job name with its plugin id", () => {
		expect(namespacePluginJobName("org.reelvault.trickplay", "generate")).toBe("org.reelvault.trickplay:generate");
	});
});

describe("plugin loader lifecycle", () => {
	test("loads, reloads, and unloads one isolated plugin scope", async () => {
		const { loader, registry } = await createLoaderFixture();

		await loader.load("lifecycle");
		expect(registry.get("org.reelvault.lifecycle")?.state).toBe("enabled");
		expect(registry.getProvider("lifecycle-provider")).toBeDefined();
		expect(registry.getSubtitleProvider("lifecycle-subtitle-provider")).toBeDefined();

		await loader.reloadPlugin("org.reelvault.lifecycle");
		expect(registry.get("org.reelvault.lifecycle")?.state).toBe("enabled");
		expect(registry.getProvider("lifecycle-provider")).toBeDefined();
		expect(registry.getSubtitleProvider("lifecycle-subtitle-provider")).toBeDefined();

		await loader.unloadPlugin("org.reelvault.lifecycle");
		expect(registry.get("org.reelvault.lifecycle")).toBeUndefined();
		expect(registry.getProvider("lifecycle-provider")).toBeUndefined();
		expect(registry.getSubtitleProvider("lifecycle-subtitle-provider")).toBeUndefined();
		expect(lifecycleEvents()).toEqual([
			"initialize",
			"subtitle-initialize",
			"enable",
			"event:enabled",
			"event:disabled",
			"disable",
			"subtitle-dispose",
			"dispose",
			"unload",
			"initialize",
			"subtitle-initialize",
			"enable",
			"event:enabled",
			"event:disabled",
			"disable",
			"subtitle-dispose",
			"dispose",
			"unload",
		]);
	});

	test("re-runs setup against the freshly installed module graph on reload", async () => {
		const pluginsDirectory = await mkdtemp(join(tmpdir(), "reelvault-plugins-"));
		temporaryDirectories.push(pluginsDirectory);
		const pluginDirectory = join(pluginsDirectory, "reloadable");
		await mkdir(pluginDirectory, { recursive: true });
		await write(
			join(pluginDirectory, "plugin.json"),
			JSON.stringify({
				id: "org.reelvault.reloadable",
				name: "Reloadable fixture",
				version: "1.0.0",
				entry: "./index.mjs",
				capabilities: ["eventHandler"],
			}),
		);
		await write(join(pluginDirectory, "value.mjs"), 'export const value = "v1";\n');
		await write(
			join(pluginDirectory, "index.mjs"),
			`import { value } from "./value.mjs";
const events = globalThis.${reloadKey} ??= [];
export default { async setup() { events.push(value); } };
`,
		);

		const registry = new PluginRegistry();
		const config: Pick<PluginConfig, "load"> = { load: async () => ({}) };
		const loader = new PluginLoader(config as PluginConfig, registry, pluginsDirectory);

		await loader.load("reloadable");
		await write(join(pluginDirectory, "value.mjs"), 'export const value = "v2";\n');
		await loader.reloadPlugin("org.reelvault.reloadable");

		expect((globalThis as Record<string, unknown>)[reloadKey]).toEqual(["v1", "v2"]);
	});

	test("cleans up registered resources even when onDisable fails", async () => {
		const { loader, registry } = await createLoaderFixture();
		await loader.load("lifecycle");
		(globalThis as Record<string, unknown>).__reelvaultPluginDisableFails = true;

		await expect(loader.unloadPlugin("org.reelvault.lifecycle")).rejects.toThrow("disable failed");
		expect(registry.get("org.reelvault.lifecycle")).toBeUndefined();
		expect(registry.getProvider("lifecycle-provider")).toBeUndefined();
		expect(registry.getSubtitleProvider("lifecycle-subtitle-provider")).toBeUndefined();
		expect(lifecycleEvents()).toEqual([
			"initialize",
			"subtitle-initialize",
			"enable",
			"event:enabled",
			"event:disabled",
			"disable",
			"subtitle-dispose",
			"dispose",
			"unload",
		]);
	});

	test("namespaces scheduled task ids that start with the plugin id so reload can reclaim them", async () => {
		const pluginsDirectory = await mkdtemp(join(tmpdir(), "reelvault-plugins-"));
		temporaryDirectories.push(pluginsDirectory);
		const pluginDirectory = join(pluginsDirectory, "tasks");
		await mkdir(pluginDirectory, { recursive: true });
		await write(
			join(pluginDirectory, "plugin.json"),
			JSON.stringify({
				id: "org.reelvault.tasks",
				name: "Tasks fixture",
				version: "1.0.0",
				entry: "./index.mjs",
				capabilities: ["jobs"],
			}),
		);
		// The task id starts with the plugin id (no colon) — the old cleanup prefix
		// match missed it, so reload hit a duplicate-worker ConflictError.
		await write(
			join(pluginDirectory, "index.mjs"),
			`export default {
  async setup(host) {
    await host.tasks.register({
      id: "org.reelvault.tasks.cleanup",
      name: "cleanup",
      defaultTriggers: [],
      run: async () => undefined,
    });
  },
};
`,
		);

		const registry = new PluginRegistry();
		const config: Pick<PluginConfig, "load"> = { load: async () => ({}) };
		const loader = new PluginLoader(config as PluginConfig, registry, pluginsDirectory);

		await loader.load("tasks");
		await expect(loader.reloadPlugin("org.reelvault.tasks")).resolves.toBeUndefined();
		await loader.unloadPlugin("org.reelvault.tasks");
		expect(registry.get("org.reelvault.tasks")).toBeUndefined();
	});

	test("calls onUnload when setup fails partway through loading", async () => {
		const pluginsDirectory = await mkdtemp(join(tmpdir(), "reelvault-plugins-"));
		temporaryDirectories.push(pluginsDirectory);
		const pluginDirectory = join(pluginsDirectory, "fail-unload");
		await mkdir(pluginDirectory, { recursive: true });
		await write(
			join(pluginDirectory, "plugin.json"),
			JSON.stringify({
				id: "org.reelvault.fail-unload",
				name: "Fail unload fixture",
				version: "1.0.0",
				entry: "./index.mjs",
				capabilities: ["eventHandler"],
			}),
		);
		await write(
			join(pluginDirectory, "index.mjs"),
			`const events = globalThis.${failUnloadKey} ??= [];
export default {
  async setup() { events.push("setup"); throw new Error("setup failed"); },
  onUnload() { events.push("unload"); },
};
`,
		);

		const registry = new PluginRegistry();
		const config: Pick<PluginConfig, "load"> = { load: async () => ({}) };
		const loader = new PluginLoader(config as PluginConfig, registry, pluginsDirectory);

		await expect(loader.load("fail-unload")).rejects.toThrow("setup failed");
		expect((globalThis as Record<string, unknown>)[failUnloadKey]).toEqual(["setup", "unload"]);
		expect(registry.get("org.reelvault.fail-unload")).toBeUndefined();
	});

	test("disposes media analyzers on unload", async () => {
		const pluginsDirectory = await mkdtemp(join(tmpdir(), "reelvault-plugins-"));
		temporaryDirectories.push(pluginsDirectory);
		const pluginDirectory = join(pluginsDirectory, "analyzer");
		await mkdir(pluginDirectory, { recursive: true });
		await write(
			join(pluginDirectory, "plugin.json"),
			JSON.stringify({
				id: "org.reelvault.analyzer",
				name: "Analyzer fixture",
				version: "1.0.0",
				entry: "./index.mjs",
				capabilities: ["mediaAnalyzer"],
			}),
		);
		await write(
			join(pluginDirectory, "index.mjs"),
			`const events = globalThis.${analyzerDisposeKey} ??= [];
export default {
  async setup(host) {
    await host.media.registerAnalyzer({
      id: "org.reelvault.analyzer-x",
      name: "Analyzer X",
      version: "1.0.0",
      analyze: () => ({}),
      dispose: () => { events.push("dispose"); },
    });
  },
};
`,
		);

		const registry = new PluginRegistry();
		const config: Pick<PluginConfig, "load"> = { load: async () => ({}) };
		const loader = new PluginLoader(config as PluginConfig, registry, pluginsDirectory);

		await loader.load("analyzer");
		await loader.unloadPlugin("org.reelvault.analyzer");
		expect((globalThis as Record<string, unknown>)[analyzerDisposeKey]).toEqual(["dispose"]);
	});

	test("rejects a path-traversal plugin identifier before touching disk", async () => {
		const { loader } = await createLoaderFixture();

		await expect(loader.load("../../tmp/evil")).rejects.toThrow("Invalid plugin identifier");
		await expect(loader.load(".hidden")).rejects.toThrow("Invalid plugin identifier");
		await expect(loader.load("a/b")).rejects.toThrow("Invalid plugin identifier");
	});

	test("rejects an invalid scheduled plugin job before it reaches the queue", async () => {
		const { loader, registry } = await createInvalidScheduleLoaderFixture();

		await expect(loader.load("invalid-schedule")).rejects.toThrow("Invalid cron expression");
		expect(registry.get("org.reelvault.invalid-schedule")).toBeUndefined();
		expect(registry.getFailedStatuses()).toMatchObject([{ id: "org.reelvault.invalid-schedule", state: "failed", failurePhase: "setup" }]);
	});

	test("a plugin that fails during provider initialization keeps its config definition", async () => {
		const pluginsDirectory = await mkdtemp(join(tmpdir(), "reelvault-plugins-"));
		temporaryDirectories.push(pluginsDirectory);
		const pluginDirectory = join(pluginsDirectory, "unconfigured");
		await mkdir(pluginDirectory, { recursive: true });
		await write(
			join(pluginDirectory, "plugin.json"),
			JSON.stringify({
				id: "org.reelvault.unconfigured",
				name: "Unconfigured fixture",
				version: "1.0.0",
				entry: "./index.mjs",
				capabilities: ["metadataProvider"],
			}),
		);
		await write(
			join(pluginDirectory, "index.mjs"),
			`export default {
  config: {
    fields: {},
    descriptors: [{ name: "accessToken", type: "secret", label: "Access token", required: true }],
    parse: (value) => value,
  },
  async setup(host) {
    await host.providers.register({
      id: "unconfigured-provider",
      name: "Unconfigured provider",
      version: "1.0.0",
      initialize() { throw new Error("requires an access token"); },
      async search() { return []; },
      async getDetails() { return null; },
      async getSeasonDetails() { return null; },
      async getEpisodeDetails() { return null; },
    });
  },
};
`,
		);

		const registry = new PluginRegistry();
		const config: Pick<PluginConfig, "load"> = { load: async () => ({}) };
		const loader = new PluginLoader(config as PluginConfig, registry, pluginsDirectory);

		await expect(loader.load("unconfigured")).rejects.toThrow("requires an access token");
		expect(registry.get("org.reelvault.unconfigured")).toBeUndefined();
		expect(registry.getFailedStatuses()).toMatchObject([{ id: "org.reelvault.unconfigured", state: "failed" }]);
		expect(registry.getConfigDefinition("org.reelvault.unconfigured")?.descriptors).toEqual([
			{ name: "accessToken", type: "secret", label: "Access token", required: true },
		]);
	});

	test("loadAll skips a plugin disabled in the lockfile; a direct load still works after re-enable", async () => {
		const { loader, registry, pluginsDirectory } = await createLoaderFixture();
		// loadAll purges expired plugin blobs first — an empty stub keeps the
		// fixture independent from migrations (same pattern as tests/database).
		await databaseFactory.getClient().run(
			sql.raw(`CREATE TABLE IF NOT EXISTS plugin_blobs (
					plugin_id TEXT NOT NULL,
					data_key TEXT NOT NULL,
					storage_key TEXT NOT NULL UNIQUE,
					content_type TEXT NOT NULL,
					size INTEGER NOT NULL,
					expires_at INTEGER NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					PRIMARY KEY (plugin_id, data_key)
				)`),
		);
		// Simulate a plugin disabled via the admin API before a restart.
		await write(
			join(pluginsDirectory, "plugins.lock.json"),
			JSON.stringify({
				version: 1,
				plugins: {
					"org.reelvault.lifecycle": {
						directory: "lifecycle",
						integrity: "sha256-ignored",
						installedAt: new Date().toISOString(),
						source: "fixture",
						version: "1.0.0",
						disabled: true,
					},
				},
			}),
		);

		await loader.loadAll();
		expect(registry.get("org.reelvault.lifecycle")).toBeUndefined();

		// The enable flow clears the flag first, then loads directly — that path
		// must keep working for installer-managed plugins.
		await loader.load("lifecycle");
		expect(registry.get("org.reelvault.lifecycle")?.state).toBe("enabled");
	});

	test("preserves the configuration phase when loading fails before module import", async () => {
		const pluginsDirectory = await mkdtemp(join(tmpdir(), "reelvault-plugins-"));
		temporaryDirectories.push(pluginsDirectory);
		const pluginDirectory = join(pluginsDirectory, "broken-config");
		await mkdir(pluginDirectory, { recursive: true });
		await write(
			join(pluginDirectory, "plugin.json"),
			JSON.stringify({
				id: "org.reelvault.broken-config",
				name: "Broken config fixture",
				version: "1.0.0",
				entry: "./index.mjs",
				capabilities: ["eventHandler"],
			}),
		);

		const registry = new PluginRegistry();
		const config: Pick<PluginConfig, "load"> = {
			load: () => Promise.reject(new Error("Configuration is invalid")),
		};
		const loader = new PluginLoader(config as PluginConfig, registry, pluginsDirectory);

		await expect(loader.load("broken-config")).rejects.toThrow("Configuration is invalid");
		expect(registry.getFailedStatuses()).toMatchObject([{ id: "org.reelvault.broken-config", state: "failed", failurePhase: "config" }]);
	});
});

async function createLoaderFixture(): Promise<{ loader: PluginLoader; registry: PluginRegistry; pluginsDirectory: string }> {
	const pluginsDirectory = await mkdtemp(join(tmpdir(), "reelvault-plugins-"));
	temporaryDirectories.push(pluginsDirectory);
	const pluginDirectory = join(pluginsDirectory, "lifecycle");
	await mkdir(pluginDirectory, { recursive: true });
	await write(
		join(pluginDirectory, "plugin.json"),
		JSON.stringify({
			id: "org.reelvault.lifecycle",
			name: "Lifecycle fixture",
			version: "1.0.0",
			entry: "./index.mjs",
			capabilities: ["metadataProvider", "subtitleProvider", "eventHandler"],
		}),
	);
	await write(join(pluginDirectory, "index.mjs"), pluginModuleSource());

	const registry = new PluginRegistry();
	const config: Pick<PluginConfig, "load"> = { load: async () => ({}) };

	return { loader: new PluginLoader(config as PluginConfig, registry, pluginsDirectory), registry, pluginsDirectory };
}

async function createInvalidScheduleLoaderFixture(): Promise<{ loader: PluginLoader; registry: PluginRegistry }> {
	const pluginsDirectory = await mkdtemp(join(tmpdir(), "reelvault-plugins-"));
	temporaryDirectories.push(pluginsDirectory);
	const pluginDirectory = join(pluginsDirectory, "invalid-schedule");
	await mkdir(pluginDirectory, { recursive: true });
	await write(
		join(pluginDirectory, "plugin.json"),
		JSON.stringify({
			id: "org.reelvault.invalid-schedule",
			name: "Invalid schedule fixture",
			version: "1.0.0",
			entry: "./index.mjs",
			capabilities: ["jobs"],
		}),
	);
	await write(
		join(pluginDirectory, "index.mjs"),
		`export default {
  async setup(host) {
    await host.jobs.register({ name: "refresh", schedule: { cron: "0 24 * * *" }, handler() {} });
  }
};
`,
	);

	const registry = new PluginRegistry();
	const config: Pick<PluginConfig, "load"> = { load: async () => ({}) };

	return { loader: new PluginLoader(config as PluginConfig, registry, pluginsDirectory), registry };
}

function lifecycleEvents(): string[] {
	return ((globalThis as Record<string, unknown>)[lifecycleKey] ?? []) as string[];
}

function pluginModuleSource(): string {
	return `
const events = globalThis.${lifecycleKey} ??= [];

export default {
  async setup(host) {
		host.events.on("plugin.enabled", ({ pluginId }) => {
		  if (pluginId === "org.reelvault.lifecycle") events.push("event:enabled");
		});
		host.events.on("plugin.disabled", ({ pluginId }) => {
		  if (pluginId === "org.reelvault.lifecycle") events.push("event:disabled");
		});
    await host.providers.register({
      id: "lifecycle-provider",
      name: "Lifecycle provider",
      version: "1.0.0",
      initialize() { events.push("initialize"); },
      dispose() { events.push("dispose"); },
      async search() { return []; },
      async getDetails() { return null; },
      async getSeasonDetails() { return null; },
      async getEpisodeDetails() { return null; }
    });
    await host.subtitles.register({
      id: "lifecycle-subtitle-provider",
      name: "Lifecycle subtitle provider",
      version: "1.0.0",
      initialize() { events.push("subtitle-initialize"); },
      dispose() { events.push("subtitle-dispose"); },
      async search() { return []; },
      async download() { return null; }
    });
  },
  onEnable() { events.push("enable"); },
  onDisable() {
    events.push("disable");
    if (globalThis.__reelvaultPluginDisableFails) throw new Error("disable failed");
  },
  onUnload() { events.push("unload"); }
};`;
}
