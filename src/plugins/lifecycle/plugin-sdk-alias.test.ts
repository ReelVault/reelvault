import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@/utils/type.utils";
import { ensurePluginSdkShim } from "./plugin-sdk-alias";

describe("plugin sdk shim", () => {
	test("lets an installed plugin resolve the SDK by package name", async () => {
		const pluginsDirectory = await mkdtemp(join(tmpdir(), `reelvault-plugin-shim-${process.pid}-`));
		try {
			const pluginDirectory = join(pluginsDirectory, "org.example.shim");
			await mkdir(pluginDirectory, { recursive: true });
			await writeFile(
				join(pluginDirectory, "entry.js"),
				'import { definePlugin, PluginHookRejection } from "reelvault-sdk/plugin";\nexport const plugin = definePlugin({ setup() {} });\nexport const Rejection = PluginHookRejection;\n',
			);

			await ensurePluginSdkShim(pluginsDirectory);

			const mod: { plugin?: { setup?: unknown }; Rejection?: unknown } = await import(join(pluginDirectory, "entry.js"));
			expect(typeof mod.plugin?.setup).toBe("function");
			// The shim must re-export the host's own module, not a copy — otherwise
			// `instanceof PluginHookRejection` checks inside the host would fail.
			expect(mod.Rejection).toBe((await import("@sdk/plugin")).PluginHookRejection);
		} finally {
			await rm(pluginsDirectory, { recursive: true, force: true });
		}
	});

	test("exposes the ui/schema subpath through the shim", async () => {
		const pluginsDirectory = await mkdtemp(join(tmpdir(), `reelvault-plugin-shim-schema-${process.pid}-`));
		try {
			await ensurePluginSdkShim(pluginsDirectory);
			const parsed: unknown = await Bun.file(join(pluginsDirectory, "node_modules", "reelvault-sdk", "package.json")).json();
			const exports = isRecord(parsed) && isRecord(parsed.exports) ? parsed.exports : undefined;
			expect(exports?.["./ui/schema"]).toBe("./ui-schema.mjs");
		} finally {
			await rm(pluginsDirectory, { recursive: true, force: true });
		}
	});
});
