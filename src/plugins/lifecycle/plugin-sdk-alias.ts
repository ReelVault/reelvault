import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@/utils/logger";
import { isRecord } from "@/utils/type.utils";

/**
 * Makes the host's own SDK importable from plugin code. Plugins import
 * `reelvault-sdk/plugin` (and the other package subpaths) — those specifiers
 * must resolve to THIS server, not to whatever `node_modules` happens to sit
 * next to a plugin directory (catalog-installed plugins ship without one). The
 * shim is materialised inside the plugins directory before any entry is
 * imported; all other specifiers fall through to ordinary resolution.
 */

/** SDK subpaths a plugin may import at runtime, mapped to their dist/source files. */
const SDK_SHIM_ENTRIES = [
	{ specifier: ".", dist: "sdk/dist/index.mjs", source: "sdk/index.ts" },
	{ specifier: "./client", dist: "sdk/dist/client/index.mjs", source: "sdk/client/index.ts" },
	{ specifier: "./common", dist: "sdk/dist/common/index.mjs", source: "sdk/common/index.ts" },
	{ specifier: "./plugin", dist: "sdk/dist/plugin/index.mjs", source: "sdk/plugin/index.ts" },
	{ specifier: "./ui", dist: "sdk/dist/ui/index.mjs", source: "sdk/ui/index.ts" },
	{ specifier: "./ui/schema", dist: "sdk/dist/ui/schema.mjs", source: "sdk/ui/schema.ts" },
	{ specifier: "./testing", dist: "sdk/dist/testing/index.mjs", source: "sdk/testing/index.ts" },
] as const;

/**
 * Materialises a `node_modules/reelvault-sdk` shim inside the plugins
 * directory so installed plugins resolve the host SDK through ordinary module
 * resolution.
 *
 * Why this exists: `Bun.plugin` `onResolve` hooks only apply to the bundler, not
 * to the runtime ESM loader, so catalog-installed `.js` plugins (which ship
 * without node_modules) could never resolve `reelvault-sdk/*`. The shim
 * re-exports the host's own SDK files, so every plugin shares one SDK identity
 * (important for `instanceof PluginHookRejection`).
 */
export async function ensurePluginSdkShim(pluginsDirectory: string): Promise<void> {
	const logger = createLogger("PluginSdkAlias");
	const serverRoot = findServerRoot();
	if (!serverRoot) {
		logger.warn("Could not locate the server package root — plugins importing the SDK by name may fail to load");

		return;
	}

	const shimDir = join(pluginsDirectory, "node_modules", "reelvault-sdk");
	const exportsMap: Record<string, string> = { "./package.json": "./package.json" };
	const files: Array<{ path: string; contents: string }> = [];

	for (const entry of SDK_SHIM_ENTRIES) {
		// Source first: the server itself imports `@sdk/*` from source at runtime, so
		// plugins must share that exact module identity (see PluginHookRejection).
		const target = firstExisting(join(serverRoot, entry.source), join(serverRoot, entry.dist));
		if (!target) continue;

		const fileName = entry.specifier === "." ? "index.mjs" : `${entry.specifier.slice(2).replaceAll("/", "-")}.mjs`;
		exportsMap[entry.specifier] = `./${fileName}`;
		files.push({ path: join(shimDir, fileName), contents: `export * from ${JSON.stringify(target)};\n` });
	}

	if (files.length === 0) {
		logger.warn("No SDK build or source found — plugins importing the SDK by name may fail to load", { serverRoot });

		return;
	}

	const manifest = { name: "reelvault-sdk", version: "1.0.0", type: "module", exports: exportsMap };
	try {
		await mkdir(join(pluginsDirectory, "node_modules"), { recursive: true });
		await Bun.write(join(shimDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		for (const file of files) {
			// Only rewrite changed files so the shim does not churn the SD card / NAS.
			const existing = existsSync(file.path) ? readFileSync(file.path, "utf8") : "";
			if (existing !== file.contents) await Bun.write(file.path, file.contents);
		}

		logger.info("Plugin SDK runtime shim ready", { shimDir });
	} catch (error) {
		logger.warn("Could not create the plugin SDK shim — plugins importing the SDK by name may fail to load", {
			shimDir,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function firstExisting(...candidates: string[]): string | undefined {
	return candidates.find((candidate) => existsSync(candidate));
}

function findServerRoot(): string | undefined {
	let directory = import.meta.dir;
	while (directory !== "/" && directory !== ".") {
		const manifestPath = join(directory, "package.json");
		if (existsSync(manifestPath)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (isRecord(parsed) && parsed.name === "reelvault-server") return directory;
			} catch {
				// A malformed package.json this deep in the walk-up is not ours — keep going.
			}
		}

		directory = join(directory, "..");
	}

	return undefined;
}
