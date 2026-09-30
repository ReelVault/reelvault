import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectInstallType } from "./update-environment";

const roots: string[] = [];

afterAll(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Copies the real module into a fake archive checkout so `import.meta.dir`
 * inside `resolveInstallRoot` resolves through the same depth the updater
 * sees in a release layout: `<root>/server/src/application/updates`.
 * Regression: resolving two levels up instead of four reported `server/src`
 * as the install root, so archive installs detected as "dev" and the panel
 * refused updates with `update.install_unsupported_install_type`.
 */
async function detectFromArchiveCheckout(root: string): Promise<string> {
	const moduleDir = join(root, "server", "src", "application", "updates");
	mkdirSync(moduleDir, { recursive: true });
	const module = readFileSync(join(import.meta.dir, "update-environment.ts"), "utf8").replace(
		"@/utils/type.utils",
		join(import.meta.dir, "../../utils/type.utils"),
	);
	writeFileSync(join(moduleDir, "update-environment.ts"), module);
	writeFileSync(join(root, "server", "package.json"), JSON.stringify({ version: "1.0.0" }));
	mkdirSync(join(root, "bun"), { recursive: true });

	const environment: unknown = await import(join(moduleDir, "update-environment.ts"));
	return (environment as { detectInstallType: (root?: string) => string }).detectInstallType();
}

describe("detectInstallType on release-archive layouts", () => {
	test("detects archive when resolved from the module's real depth", async () => {
		const root = mkdtempSync(join(tmpdir(), "reelvault-archive-root-"));
		roots.push(root);

		expect(await detectFromArchiveCheckout(root)).toBe("archive");
	});

	test("still detects dev checkouts", () => {
		const repo = mkdtempSync(join(tmpdir(), "reelvault-dev-root-"));
		roots.push(repo);
		mkdirSync(join(repo, "src", "application", "updates"), { recursive: true });

		expect(detectInstallType(repo)).toBe("dev");
	});
});
