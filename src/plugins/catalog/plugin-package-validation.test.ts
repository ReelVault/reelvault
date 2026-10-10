import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveValidationFailure, validatePluginPackage } from "./plugin-package-validation";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

const DEFAULT_FILES: Record<string, string> = { "index.mjs": "export default {};" };

async function createPackage(manifest: Record<string, unknown> | null, files: Record<string, string> = DEFAULT_FILES) {
	const root = await mkdtemp(join(tmpdir(), "reelvault-plugin-validation-"));
	temporaryDirectories.push(root);
	await mkdir(root, { recursive: true });
	if (manifest) {
		await writeFile(
			join(root, "plugin.json"),
			JSON.stringify({
				id: "org.reelvault.validated",
				name: "Validated",
				version: "2.0.0",
				entry: "./index.mjs",
				capabilities: ["eventHandler"],
				...manifest,
			}),
		);
	}
	for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);

	return root;
}

describe("validatePluginPackage", () => {
	test("reports a valid package as installable, with no issues", async () => {
		const root = await createPackage({});

		await expect(validatePluginPackage(root, [])).resolves.toEqual({
			valid: true,
			pluginId: "org.reelvault.validated",
			version: "2.0.0",
			direction: "install",
			issues: [],
		});
	});

	test("blocks a package whose manifest cannot be read", async () => {
		const root = await createPackage(null);

		const result = await validatePluginPackage(root, []);

		expect(result.valid).toBe(false);
		expect(result.issues).toEqual([expect.objectContaining({ severity: "error", code: "plugin.manifest_missing" })]);
	});

	test("blocks a package whose entry point is missing", async () => {
		const root = await createPackage({ entry: "./missing.mjs" }, {});

		const result = await validatePluginPackage(root, []);

		expect(result.valid).toBe(false);
		expect(result.issues).toEqual([expect.objectContaining({ severity: "error", code: "plugin.entry_missing" })]);
	});

	test("blocks a package that needs a newer server", async () => {
		const root = await createPackage({ minServerVersion: "999.0.0" });

		const result = await validatePluginPackage(root, []);

		expect(result.valid).toBe(false);
		expect(result.issues.map((item) => item.code)).toEqual(["plugin.server_too_old"]);
	});

	test("keeps a package with a malformed interface manifest installable and warns about it", async () => {
		const root = await createPackage({}, { "index.mjs": "export default {};", "ui.json": "{ not json" });

		const result = await validatePluginPackage(root, []);

		expect(result.valid).toBe(true);
		expect(result.issues).toEqual([expect.objectContaining({ severity: "warning", code: "plugin.ui_manifest_invalid" })]);
	});

	test("describes a replacement of an installed version and warns when it is a downgrade", async () => {
		const root = await createPackage({ version: "1.0.0" });

		const result = await validatePluginPackage(root, [{ id: "org.reelvault.validated", version: "2.0.0" }]);

		expect(result).toMatchObject({ valid: true, installedVersion: "2.0.0", direction: "downgrade" });
		expect(result.issues).toEqual([expect.objectContaining({ severity: "warning", code: "plugin.version_downgrade" })]);
	});

	test("keeps the specific code and parameters of a manifest error, so the report can name the field", async () => {
		const root = await createPackage({ id: "bad id!" });

		const result = await validatePluginPackage(root, []);

		expect(result.valid).toBe(false);
		expect(result.issues).toEqual([expect.objectContaining({ severity: "error", code: "plugin.id_invalid", params: { id: "bad id!" } })]);
	});

	test("keeps the field of an interface manifest error in the warning", async () => {
		const uiManifest = { name: "UI", version: "1.0.0", pages: "home" };
		const root = await createPackage({}, { "index.mjs": "export default {};", "ui.json": JSON.stringify(uiManifest) });

		const result = await validatePluginPackage(root, []);

		expect(result.valid).toBe(true);
		expect(result.issues).toEqual([
			expect.objectContaining({ severity: "warning", code: "plugin.ui.field_not_array", params: { field: "pages" } }),
		]);
	});

	test("reports a missing interface field with the interface code, not the plugin.json one", async () => {
		const root = await createPackage({}, { "index.mjs": "export default {};", "ui.json": JSON.stringify({ version: "1.0.0" }) });

		const result = await validatePluginPackage(root, []);

		expect(result.issues).toEqual([
			expect.objectContaining({ severity: "warning", code: "plugin.ui.field_not_string", params: { field: "ui.name" } }),
		]);
	});
});

describe("archiveValidationFailure", () => {
	test("reports an archive that could not be unpacked as an invalid archive", () => {
		expect(archiveValidationFailure(new Error("not a zip"))).toEqual({
			valid: false,
			issues: [{ severity: "error", code: "plugin.archive_invalid", message: "not a zip" }],
		});
	});
});
