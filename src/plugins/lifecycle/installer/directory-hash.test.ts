import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateDirectoryIntegrity } from "./directory-hash";

const temporaryDirectories: string[] = [];
const SHA256_PREFIX_REGEX = /^sha256-/;

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
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

		expect(first).toMatch(SHA256_PREFIX_REGEX);
		expect(first).toBe(second);
	});

	test("changes when file content or structure changes", async () => {
		const base = await createPackage();
		const edited = await createPackage();
		await writeFile(join(edited, "index.mjs"), "export default { setup() { return 2; } };\n");
		const renamed = await createPackage();
		await writeFile(join(renamed, "moved.mjs"), await Bun.file(join(renamed, "index.mjs")).text());
		await rm(join(renamed, "index.mjs"));

		const baseHash = await calculateDirectoryIntegrity(base);
		expect(await calculateDirectoryIntegrity(edited)).not.toBe(baseHash);
		expect(await calculateDirectoryIntegrity(renamed)).not.toBe(baseHash);
	});

	test("excludes the mutable admin config.json at the package root only", async () => {
		const base = await createPackage();
		const withRootConfig = await createPackage();
		await writeFile(join(withRootConfig, "config.json"), '{"apiKey":"secret"}\n');
		const withNestedConfig = await createPackage();
		await writeFile(join(withNestedConfig, "assets", "config.json"), '{"apiKey":"secret"}\n');

		const baseHash = await calculateDirectoryIntegrity(base);
		expect(await calculateDirectoryIntegrity(withRootConfig)).toBe(baseHash);
		expect(await calculateDirectoryIntegrity(withNestedConfig)).not.toBe(baseHash);
	});

	test("rejects unsupported filesystem entries such as symlinks", async () => {
		const pkg = await createPackage();
		await symlink(join(pkg, "plugin.json"), join(pkg, "linked.mjs"));

		await expect(calculateDirectoryIntegrity(pkg)).rejects.toThrow("unsupported filesystem entry");
	});
});
