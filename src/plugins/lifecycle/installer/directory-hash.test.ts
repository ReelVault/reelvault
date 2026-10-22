import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@/utils/directory.utils";
import { calculateDirectoryIntegrity } from "./directory-hash.utils";

const temporaryDirectories: string[] = [];

/**
 * The sha256 digests of the fixture package, derived by hand from the hashing
 * algorithm (sorted entries, `directory:<path>\0` / `file:<path>\0` markers and
 * the file bytes) — the digests never depend on the host.
 */
const BASE_PACKAGE_DIGEST = "sha256-fRJGcxBSmbA0L7vJB9bkHoByuCmuIr0VoFhL+nJ5ceM=";
const EDITED_PACKAGE_DIGEST = "sha256-7WwYRv/Txkc4HIZfBJPki8fIU0/Kea4iPwrGB/zVQ/Q=";
const RENAMED_PACKAGE_DIGEST = "sha256-9rrdEmLFNv+VqkJYaezOpCNwBK2XiSaUjnjRjac6NWE=";
const NESTED_CONFIG_DIGEST = "sha256-CulNNB9SZiVkpA2UMa6ZnXKDYa/DiBWdfTPst1kO47U=";

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await removeTree(directory)));
});

async function createPackage(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "reelvault-dirhash-"));
	temporaryDirectories.push(root);
	const pkg = join(root, "pkg");
	await mkdir(join(pkg, "assets"), { recursive: true });
	await writeFile(join(pkg, "plugin.json"), '{"id":"x"}\n');
	await writeFile(join(pkg, "index.mjs"), "export default { setup() {} };\n");
	await writeFile(join(pkg, "assets", "data.bin"), "0123456789".repeat(100));

	return pkg;
}

describe("calculateDirectoryIntegrity", () => {
	test("produces a deterministic sha256 digest for identical trees", async () => {
		const first = await calculateDirectoryIntegrity(await createPackage());
		const second = await calculateDirectoryIntegrity(await createPackage());

		expect(first).toBe(BASE_PACKAGE_DIGEST);
		expect(second).toBe(BASE_PACKAGE_DIGEST);
	});

	test("changes when file content or structure changes", async () => {
		const base = await createPackage();
		const edited = await createPackage();
		await writeFile(join(edited, "index.mjs"), "export default { setup() { return 2; } };\n");
		const renamed = await createPackage();
		await writeFile(join(renamed, "moved.mjs"), await Bun.file(join(renamed, "index.mjs")).text());
		await rm(join(renamed, "index.mjs"));

		expect(await calculateDirectoryIntegrity(base)).toBe(BASE_PACKAGE_DIGEST);
		expect(await calculateDirectoryIntegrity(edited)).toBe(EDITED_PACKAGE_DIGEST);
		expect(await calculateDirectoryIntegrity(renamed)).toBe(RENAMED_PACKAGE_DIGEST);
	});

	test("excludes the mutable admin config.json at the package root only", async () => {
		const base = await createPackage();
		const withRootConfig = await createPackage();
		await writeFile(join(withRootConfig, "config.json"), '{"apiKey":"secret"}\n');
		const withNestedConfig = await createPackage();
		await writeFile(join(withNestedConfig, "assets", "config.json"), '{"apiKey":"secret"}\n');

		expect(await calculateDirectoryIntegrity(base)).toBe(BASE_PACKAGE_DIGEST);
		expect(await calculateDirectoryIntegrity(withRootConfig)).toBe(BASE_PACKAGE_DIGEST);
		expect(await calculateDirectoryIntegrity(withNestedConfig)).toBe(NESTED_CONFIG_DIGEST);
	});

	test("rejects unsupported filesystem entries such as symlinks", async () => {
		const pkg = await createPackage();
		await symlink(join(pkg, "plugin.json"), join(pkg, "linked.mjs"));

		await expect(calculateDirectoryIntegrity(pkg)).rejects.toMatchObject({
			category: "validation",
			code: "plugin.package_entry_unsupported",
		});
	});
});
