import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { pluginCatalogService } from "./plugin-catalog.service";

/** The archive check reports what an install would do, and installs nothing. */
describe("pluginCatalogService.validateArchive", () => {
	test("checks a valid package and never installs it", async () => {
		const manifest = {
			id: "org.reelvault.dry-run",
			name: "Dry run",
			version: "1.0.0",
			entry: "./index.mjs",
			capabilities: ["eventHandler"],
		};
		const archive = new Blob([zipSync({ "plugin.json": strToU8(JSON.stringify(manifest)), "index.mjs": strToU8("export default {};") })]);
		const install = stubMethod(pluginManager, "installFromDirectory", () => {
			throw new Error("a validation must not install the package");
		});
		const installed = stubMethod(pluginManager, "getInstalledRecords", () => Promise.resolve([]));
		try {
			const result = await pluginCatalogService.validateArchive(archive);

			expect(result).toMatchObject({ valid: true, pluginId: "org.reelvault.dry-run", direction: "install", issues: [] });
			expect(install.calls.length).toBe(0);
		} finally {
			install.restore();
			installed.restore();
		}
	});

	test("reports bytes that are not an archive as a failed check instead of throwing", async () => {
		const result = await pluginCatalogService.validateArchive(new Blob([new Uint8Array([1, 2, 3])]));

		expect(result).toMatchObject({ valid: false });
	});
});
