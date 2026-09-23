import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	MediaAnalyzer,
	MetadataProvider,
	PluginManifest,
	PluginRuntime,
	PluginUiManifest,
	ReelVaultPlugin,
	SubtitleProvider,
} from "@sdk/plugin";
import { PluginRegistry } from "./plugin.registry";

process.env.NODE_ENV ??= "test";
process.env.APP_PORT ??= "3030";
process.env.ROOT_DIR ??= join(tmpdir(), `reelvault-tests-${process.pid}`);

const plugin: ReelVaultPlugin = { setup: async () => undefined };

function createProvider(id: string): MetadataProvider {
	return {
		id,
		name: id.toUpperCase(),
		version: "1.0.0",
		initialize: async () => undefined,
		search: async () => [],
		getDetails: async () => null,
		getSeasonDetails: async () => null,
		getEpisodeDetails: async () => null,
	};
}

function createRuntime(id: string, providers: MetadataProvider[] = [], subtitleProviders: SubtitleProvider[] = []): PluginRuntime {
	const manifest: PluginManifest = {
		id,
		name: id,
		version: "1.0.0",
		entry: "./dist/index.js",
		capabilities: [],
	};

	return {
		manifest,
		plugin,
		state: "discovered",
		providerIds: providers.map((provider) => provider.id),
		subtitleProviderIds: subtitleProviders.map((provider) => provider.id),
		analyzerIds: [],
		jobNames: [],
	};
}

function createSubtitleProvider(id: string): SubtitleProvider {
	return {
		id,
		name: id.toUpperCase(),
		version: "1.0.0",
		initialize: async () => undefined,
		search: async () => [],
		download: async () => null,
	};
}

function createAnalyzer(id: string, analyze: MediaAnalyzer["analyze"]): MediaAnalyzer {
	return { id, name: id.toUpperCase(), version: "1.0.0", analyze };
}

describe("plugin registry", () => {
	const registry = new PluginRegistry();

	afterEach(() => registry.clear());

	it("registers declarative runtime providers", () => {
		const provider = createProvider("tmdb");
		registry.register(createRuntime("metadata-tmdb", [provider]), [provider]);

		expect(registry.get("metadata-tmdb")?.manifest.id).toBe("metadata-tmdb");
		expect(registry.getProvider("tmdb")).toBe(provider);
		expect(registry.getProviderStatus()).toEqual([{ id: "tmdb", name: "TMDB", version: "1.0.0", pluginId: "metadata-tmdb" }]);
		expect(registry.get("metadata-tmdb")?.state).toBe("initialized");
		registry.enable("metadata-tmdb");
		expect(registry.get("metadata-tmdb")?.state).toBe("enabled");
	});

	it("registers and removes subtitle providers independently from metadata providers", () => {
		const provider = createSubtitleProvider("opensubtitles");
		registry.register(createRuntime("subtitles", [], [provider]), [], [], [provider]);

		expect(registry.getSubtitleProvider("opensubtitles")).toBe(provider);
		expect(registry.getSubtitleProviderStatus()).toEqual([
			{ id: "opensubtitles", name: "OPENSUBTITLES", version: "1.0.0", pluginId: "subtitles" },
		]);
		expect(registry.unregister("subtitles")).toBeTrue();
		expect(registry.getSubtitleProvider("opensubtitles")).toBeUndefined();
	});

	it("rejects duplicate plugin and provider identifiers", () => {
		const provider = createProvider("tmdb");
		registry.register(createRuntime("first", [provider]), [provider]);

		expect(() => registry.register(createRuntime("first"), [])).toThrow('Plugin "first"');
		expect(() => registry.register(createRuntime("second", [createProvider("tmdb")]), [createProvider("tmdb")])).toThrow('Provider "tmdb"');
	});

	it("does not partially register providers when validation fails", () => {
		const provider = createProvider("tmdb");
		registry.register(createRuntime("first", [provider]), [provider]);
		const duplicate = createProvider("tmdb");

		expect(() => registry.register(createRuntime("second", [duplicate]), [duplicate])).toThrow('Provider "tmdb"');
		expect(registry.get("second")).toBeUndefined();
		expect(registry.getProviders()).toHaveLength(1);
	});

	it("preserves a failed declarative runtime status after cleanup", () => {
		registry.register(createRuntime("broken"), []);
		registry.fail("broken", new Error("Initialization failed"));
		registry.unregister("broken", true);

		expect(registry.get("broken")).toBeUndefined();
		expect(registry.getFailedStatuses()).toEqual([
			{
				id: "broken",
				name: "broken",
				version: "1.0.0",
				state: "failed",
				providers: 0,
				subtitleProviders: 0,
				jobs: 0,
				error: "Initialization failed",
				failurePhase: "activation",
			},
		]);
	});

	it("tracks a failed load by its lifecycle state and failing phase", () => {
		const runtime = createRuntime("broken-import");
		registry.begin(runtime.manifest);
		registry.advance(runtime.manifest.id, "validated", "config");
		registry.advance(runtime.manifest.id, "resolved", "entry");
		registry.markPhase(runtime.manifest.id, "import");

		registry.fail(runtime.manifest.id, new Error("Module could not be imported"));
		registry.unregister(runtime.manifest.id, true);

		expect(registry.getFailedStatuses()).toEqual([
			{
				id: "broken-import",
				name: "broken-import",
				version: "1.0.0",
				state: "failed",
				providers: 0,
				subtitleProviders: 0,
				jobs: 0,
				error: "Module could not be imported",
				failurePhase: "import",
			},
		]);
	});

	it("rejects duplicate lifecycle transitions", () => {
		registry.begin(createRuntime("lifecycle").manifest);
		registry.advance("lifecycle", "validated", "config");
		registry.advance("lifecycle", "resolved", "entry");

		expect(() => registry.advance("lifecycle", "resolved", "entry")).toThrow("cannot transition from resolved to resolved");
	});

	it("removes all resources when a plugin is unregistered", () => {
		const provider = createProvider("tmdb");
		registry.register(createRuntime("metadata-tmdb", [provider]), [provider]);

		expect(registry.unregister("metadata-tmdb")).toBe(true);
		expect(registry.get("metadata-tmdb")).toBeUndefined();
		expect(registry.getProvider("tmdb")).toBeUndefined();
	});

	it("advances the generation on register and unregister so provider caches epoch", () => {
		const before = registry.getGeneration();
		const provider = createProvider("gen");
		registry.register(createRuntime("gen-plugin", [provider]), [provider]);
		const afterRegister = registry.getGeneration();
		expect(afterRegister).toBeGreaterThan(before);

		registry.unregister("gen-plugin");
		expect(registry.getGeneration()).toBeGreaterThan(afterRegister);
	});

	it("runs media analyzers in order and isolates analyzer failures", async () => {
		const first = createAnalyzer("first", () => ({ source: "WEB-DL" }));
		const broken = createAnalyzer("broken", () => {
			throw new Error("analysis failed");
		});
		const second = createAnalyzer("second", () => ({ qualityTag: "2160p" }));
		const runtime = createRuntime("media-analysis");
		runtime.analyzerIds = [first.id, broken.id, second.id];
		registry.register(runtime, [], [first, broken, second]);

		await expect(
			registry.analyzeMedia({ id: "file-1", metadataId: "metadata-1", fileName: "movie.mkv", available: true }),
		).resolves.toEqual({ source: "WEB-DL", qualityTag: "2160p" });
	});
});

describe("plugin registry ui manifests", () => {
	const registry = new PluginRegistry();

	afterEach(() => registry.clear());

	const uiManifest: PluginUiManifest = {
		name: "Example UI",
		version: "1.0.0",
		entry: "./dist/ui/index.js",
		pages: [
			{ id: "public", path: "public", name: "Public", tag: "rv-example-public", nav: "user" },
			{ id: "admin", path: "admin", name: "Admin", tag: "rv-example-admin", nav: "admin", adminOnly: true },
		],
		dialogs: [
			{ id: "public-dialog", title: "Public", tag: "rv-example-public-dialog" },
			{ id: "admin-dialog", title: "Admin", tag: "rv-example-admin-dialog", adminOnly: true },
		],
		tabs: {
			details: [
				{ id: "public-tab", host: "details", label: "Public", page: "public" },
				{ id: "admin-tab", host: "details", label: "Admin", page: "admin", adminOnly: true },
			],
		},
		slots: {
			"player-footer": [
				{ label: "Public", action: { type: "page", page: "public" } },
				{ label: "Admin", action: { type: "page", page: "admin" } },
				{ label: "Admin dialog", action: { type: "dialog", dialog: "admin-dialog" } },
			],
		},
	};

	function registerEnabledUiPlugin(): void {
		registry.register(createRuntime("org.example.ui"), []);
		registry.enable("org.example.ui");
		registry.setUiManifest("org.example.ui", uiManifest);
	}

	it("omits disabled plugins entirely", () => {
		registry.register(createRuntime("org.example.ui"), []);
		registry.setUiManifest("org.example.ui", uiManifest);

		expect(registry.getUiManifestsForRole(true)).toEqual({});
	});

	it("returns the full manifest to admins", () => {
		registerEnabledUiPlugin();

		const manifest = registry.getUiManifestsForRole(true)["org.example.ui"];
		expect(manifest?.pages).toHaveLength(2);
		expect(manifest?.slots?.["player-footer"]).toHaveLength(3);
	});

	it("strips admin-only surfaces and their references for non-admins", () => {
		registerEnabledUiPlugin();

		const manifest = registry.getUiManifestsForRole(false)["org.example.ui"];
		expect(manifest?.pages?.map((page) => page.id)).toEqual(["public"]);
		expect(manifest?.dialogs?.map((dialog) => dialog.id)).toEqual(["public-dialog"]);
		expect(manifest?.tabs?.details?.map((tab) => tab.id)).toEqual(["public-tab"]);
		expect(manifest?.slots?.["player-footer"]).toHaveLength(1);
		expect(manifest?.slots?.["player-footer"]?.[0]?.label).toBe("Public");
	});

	it("drops the ui manifest when the plugin is unregistered", () => {
		registerEnabledUiPlugin();

		expect(registry.unregister("org.example.ui")).toBe(true);
		expect(registry.getUiManifest("org.example.ui")).toBeUndefined();
		expect(registry.getUiManifestsForRole(true)).toEqual({});
	});

	it("rejects two plugins that declare the same custom element tag", () => {
		registerEnabledUiPlugin();
		registry.register(createRuntime("org.example.other"), []);
		registry.enable("org.example.other");

		expect(() => registry.setUiManifest("org.example.other", { ...uiManifest, name: "Other" })).toThrow(
			'both declare the custom element "rv-example-public"',
		);
	});
});
