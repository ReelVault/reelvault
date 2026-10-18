import { afterEach, describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { pluginCatalogService } from "./plugin-catalog.service";

const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

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
		// Installing would throw here, so a validation that installs reports itself invalid and fails the check below.
		stubs.push(
			stubMethod(pluginManager, "installFromDirectory", () => {
				throw new Error("a validation must not install the package");
			}),
			stubMethod(pluginManager, "getInstalledRecords", () => Promise.resolve([])),
		);

		const result = await pluginCatalogService.validateArchive(archive);

		expect(result).toMatchObject({ valid: true, pluginId: "org.reelvault.dry-run", direction: "install", issues: [] });
	});

	test("reports bytes that are not an archive as a failed check instead of throwing", async () => {
		const result = await pluginCatalogService.validateArchive(new Blob([new Uint8Array([1, 2, 3])]));

		expect(result).toMatchObject({ valid: false });
	});
});
