import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@/utils/directory.utils";
import { ensurePluginSdkShim } from "./plugin-sdk-alias.utils";

describe("plugin sdk shim", () => {
	test("lets an installed plugin resolve the SDK by package name", async () => {
		const pluginsDirectory = await mkdtemp(join(tmpdir(), `reelvault-plugin-shim-${process.pid}-`));
		try {
			const pluginDirectory = join(pluginsDirectory, "org.example.shim");
			await mkdir(pluginDirectory, { recursive: true });
			await writeFile(
				join(pluginDirectory, "entry.js"),
				'import { definePlugin, PluginHookRejection } from "@reelvault/sdk/plugin";\nexport const plugin = definePlugin({ setup() {} });\nexport const Rejection = PluginHookRejection;\n',
			);

			await ensurePluginSdkShim(pluginsDirectory);

			const mod = await import(join(pluginDirectory, "entry.js"));
			expect(typeof mod.plugin.setup).toBe("function");
			// The shim must re-export the host's own module, not a copy — otherwise
			// `instanceof PluginHookRejection` checks inside the host would fail.
			expect(mod.Rejection).toBe((await import("@reelvault/sdk/plugin")).PluginHookRejection);
		} finally {
			await removeTree(pluginsDirectory);
		}
	});

	test("lets an installed plugin import the ui schema subpath by package name", async () => {
		const pluginsDirectory = await mkdtemp(join(tmpdir(), `reelvault-plugin-shim-schema-${process.pid}-`));
		try {
			const pluginDirectory = join(pluginsDirectory, "org.example.schema");
			await mkdir(pluginDirectory, { recursive: true });
			await writeFile(join(pluginDirectory, "schema.js"), 'export * from "@reelvault/sdk/ui/schema";\n');

			await ensurePluginSdkShim(pluginsDirectory);

			const plugin = await import(join(pluginDirectory, "schema.js"));
			const host = await import("@reelvault/sdk/ui/schema");
			expect(Object.keys(host).length).toBeGreaterThan(0);
			expect(Object.keys(plugin).toSorted()).toEqual(Object.keys(host).toSorted());
		} finally {
			await removeTree(pluginsDirectory);
		}
	});
});
