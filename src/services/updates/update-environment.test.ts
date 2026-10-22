import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeSync } from "@/utils/directory.utils";
import { detectInstallType } from "./update-environment.utils";

const roots: string[] = [];

afterAll(() => {
	for (const root of roots.splice(0)) removeTreeSync(root);
});

function createRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);

	return root;
}

function createBundledRuntime(root: string): void {
	mkdirSync(join(root, "bun"), { recursive: true });
}

function createServerManifest(root: string): void {
	mkdirSync(join(root, "server"), { recursive: true });
	writeFileSync(join(root, "server", "package.json"), JSON.stringify({ version: "1.0.0" }));
}

/**
 * Copies the real module to `<root>/server/src/services/updates`, the depth the updater runs at in a release layout,
 * and imports the copy. Its `@/utils/...` imports are rewritten to sit next to it, so a new dependency on a util does
 * not break this test.
 * Regression: resolving two levels up instead of four reported `server/src` as the install root, so archive installs
 * detected as "dev" and the panel refused updates with `update.install_unsupported_install_type`.
 */
async function importReleaseLayoutModule(root: string): Promise<{ resolveInstallRoot: () => string }> {
	const moduleDir = join(root, "server", "src", "services", "updates");
	const utilsDir = join(moduleDir, "utils");
	mkdirSync(utilsDir, { recursive: true });
	const source = readFileSync(join(import.meta.dir, "update-environment.utils.ts"), "utf8");
	const module = source.replaceAll(/@\/utils\/([\w.-]+)/g, (_match, name: string) => {
		copyFileSync(join(import.meta.dir, "../../utils", `${name}.ts`), join(utilsDir, `${name}.ts`));

		return `./utils/${name}.ts`;
	});
	const modulePath = join(moduleDir, "update-environment.utils.ts");
	writeFileSync(modulePath, module);

	const environment: unknown = await import(modulePath);

	return environment as { resolveInstallRoot: () => string };
}

describe("detectInstallType and resolveInstallRoot", () => {
	test("resolves the install root four levels above the module", async () => {
		const root = createRoot("reelvault-archive-root-");
		const environment = await importReleaseLayoutModule(root);

		expect(environment.resolveInstallRoot()).toBe(root);
	});

	test("detects archive when the bundled runtime and the server manifest are both present", () => {
		const root = createRoot("reelvault-archive-root-");
		createBundledRuntime(root);
		createServerManifest(root);

		expect(detectInstallType(root, null)).toBe("archive");
	});

	test.each([
		{ layout: "only the server manifest", bundledRuntime: false, serverManifest: true },
		{ layout: "only the bundled runtime", bundledRuntime: true, serverManifest: false },
		{ layout: "neither marker", bundledRuntime: false, serverManifest: false },
	])("detects a checkout with $layout as dev", ({ bundledRuntime, serverManifest }) => {
		const root = createRoot("reelvault-dev-root-");
		if (bundledRuntime) createBundledRuntime(root);
		if (serverManifest) createServerManifest(root);

		expect(detectInstallType(root, null)).toBe("dev");
	});

	test("reports a container install as docker even when the archive layout is present", () => {
		const root = createRoot("reelvault-archive-root-");
		createBundledRuntime(root);
		createServerManifest(root);

		expect(detectInstallType(root, "podman")).toBe("docker");
	});
});
