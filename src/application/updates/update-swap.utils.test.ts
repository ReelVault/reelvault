import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPreviousVersion, swapBackFromPrevious, swapIntoPlace, swapWebDirectory } from "./update-swap.utils";

let root: string;
const tempDirs: string[] = [];

/** Lays out a release-archive-style app directory with the given version baked into its files. */
function makeAppLayout(base: string, version: string): string {
	const app = join(base, "ReelVault");
	mkdirSync(join(app, "server", "src"), { recursive: true });
	mkdirSync(join(app, "web"), { recursive: true });
	mkdirSync(join(app, "bun"), { recursive: true });
	writeFileSync(join(app, "server", "package.json"), JSON.stringify({ version }));
	writeFileSync(join(app, "server", "src", "index.ts"), `// v${version}`);
	writeFileSync(join(app, "web", "index.html"), `<html>v${version}</html>`);
	writeFileSync(join(app, "bun", "bun"), `bun-${version}`);
	writeFileSync(join(app, "start.sh"), `#!/bin/sh\n# launcher v${version}`);

	return app;
}

function makeInstalledRoot(serverVersion: string, webVersion: string): string {
	const target = mkdtempSync(join(tmpdir(), "rv-update-root-"));
	tempDirs.push(target);
	const staging = mkdtempSync(join(tmpdir(), "rv-update-src-"));
	tempDirs.push(staging);
	makeAppLayout(staging, serverVersion);
	cpSync(join(staging, "ReelVault"), target, { recursive: true });
	rmSync(join(staging, "ReelVault"), { recursive: true, force: true });
	// web/ lives in the root, not inside ReelVault/ (separate component release)
	writeFileSync(join(target, "web", "index.html"), `<html>v${webVersion}</html>`);
	writeFileSync(join(target, "settings.env"), "export APP_PORT=3030\n");
	mkdirSync(join(target, "data"), { recursive: true });
	writeFileSync(join(target, "data", "reelvault.db"), "db");

	return target;
}

function makeWebZipLayout(version: string): string {
	// The web zip root IS the new web/ — index.html at its root.
	const dir = mkdtempSync(join(tmpdir(), "rv-update-webzip-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "index.html"), `<html>web v${version}</html>`);
	writeFileSync(join(dir, "version.json"), JSON.stringify({ version }));

	return dir;
}

beforeAll(() => {
	root = makeInstalledRoot("1.0.0", "0.1.0");
});

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server component swap", () => {
	test("update moves the old server set aside, keeps web and data", () => {
		const staged = mkdtempSync(join(tmpdir(), "rv-update-staged-"));
		tempDirs.push(staged);
		makeAppLayout(staged, "1.1.0");

		swapIntoPlace(root, join(staged, "ReelVault"), "server", "1.0.0");

		// New server version is live
		expect(readFileSync(join(root, "server", "src", "index.ts"), "utf8")).toContain("1.1.0");
		// Web was NOT touched (separate component)
		expect(readFileSync(join(root, "web", "index.html"), "utf8")).toContain("v0.1.0");
		// Old server set is preserved under .previous with its own marker
		expect(JSON.parse(readFileSync(join(root, ".previous", "server", "package.json"), "utf8")).version).toBe("1.0.0");
		expect(readPreviousVersion(root, "server")).toBe("1.0.0");
		expect(existsSync(join(root, ".previous", "web"))).toBe(false);
		// Unrelated files survive
		expect(readFileSync(join(root, "settings.env"), "utf8")).toContain("APP_PORT");
		expect(existsSync(join(root, "data", "reelvault.db"))).toBe(true);
	});

	test("server rollback restores the server set and clears only its marker", () => {
		const restored = swapBackFromPrevious(root, "server");

		expect(restored).toBe("1.0.0");
		expect(readFileSync(join(root, "server", "src", "index.ts"), "utf8")).toContain("1.0.0");
		expect(existsSync(join(root, ".previous"))).toBe(false);
		// The displaced 1.1.0 set went to the discard area
		expect(JSON.parse(readFileSync(join(root, ".update-discard", "server", "package.json"), "utf8")).version).toBe("1.1.0");
	});

	test("a server archive without bin/ keeps the installed bin/", () => {
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "bin", "ffmpeg"), "ffmpeg-binary");
		const staged = mkdtempSync(join(tmpdir(), "rv-update-staged-"));
		tempDirs.push(staged);
		makeAppLayout(staged, "1.2.0");

		swapIntoPlace(root, join(staged, "ReelVault"), "server", "1.1.0");

		expect(readFileSync(join(root, "bin", "ffmpeg"), "utf8")).toBe("ffmpeg-binary");
		expect(existsSync(join(root, ".previous", "bin"))).toBe(false);
	});
});

describe("web component swap", () => {
	test("the extracted zip root becomes web/ without touching the server", () => {
		const serverIndexBefore = readFileSync(join(root, "server", "src", "index.ts"), "utf8");
		const extracted = makeWebZipLayout("0.2.0");

		swapWebDirectory(root, extracted, "0.1.0");

		expect(readFileSync(join(root, "web", "index.html"), "utf8")).toContain("web v0.2.0");
		expect(JSON.parse(readFileSync(join(root, "web", "version.json"), "utf8")).version).toBe("0.2.0");
		expect(readFileSync(join(root, "server", "src", "index.ts"), "utf8")).toBe(serverIndexBefore);
		expect(readPreviousVersion(root, "web")).toBe("0.1.0");
		expect(existsSync(join(root, ".previous", "web"))).toBe(true);
	});

	test("web rollback restores the old dist and clears its marker", () => {
		// The bin-edge test above left a server marker behind — clear it so this
		// scenario covers the "last backup removed" path.
		rmSync(join(root, ".previous", "SERVER_VERSION"), { force: true });

		const restored = swapBackFromPrevious(root, "web");

		expect(restored).toBe("0.1.0");
		expect(readFileSync(join(root, "web", "index.html"), "utf8")).toContain("v0.1.0");
		expect(existsSync(join(root, ".previous"))).toBe(false);
	});

	test("readPreviousVersion throws when no backup exists", () => {
		expect(() => readPreviousVersion(root, "web")).toThrow();
	});
});

describe("repeated updates", () => {
	test("a second server update replaces the rollback snapshot instead of failing", () => {
		const ownRoot = makeInstalledRoot("1.0.0", "0.1.0");
		const first = mkdtempSync(join(tmpdir(), "rv-update-first-"));
		tempDirs.push(first);
		makeAppLayout(first, "1.1.0");
		swapIntoPlace(ownRoot, join(first, "ReelVault"), "server", "1.0.0");

		const second = mkdtempSync(join(tmpdir(), "rv-update-second-"));
		tempDirs.push(second);
		makeAppLayout(second, "1.2.0");

		expect(() => swapIntoPlace(ownRoot, join(second, "ReelVault"), "server", "1.1.0")).not.toThrow();
		expect(readFileSync(join(ownRoot, "server", "src", "index.ts"), "utf8")).toContain("1.2.0");
		expect(readPreviousVersion(ownRoot, "server")).toBe("1.1.0");
		expect(JSON.parse(readFileSync(join(ownRoot, ".previous", "server", "package.json"), "utf8")).version).toBe("1.1.0");
	});

	test("a second web update replaces the rollback snapshot instead of failing", () => {
		const ownRoot = makeInstalledRoot("1.0.0", "0.1.0");
		swapWebDirectory(ownRoot, makeWebZipLayout("0.2.0"), "0.1.0");

		expect(() => swapWebDirectory(ownRoot, makeWebZipLayout("0.3.0"), "0.2.0")).not.toThrow();
		expect(readFileSync(join(ownRoot, "web", "index.html"), "utf8")).toContain("web v0.3.0");
		expect(readPreviousVersion(ownRoot, "web")).toBe("0.2.0");
		expect(readFileSync(join(ownRoot, ".previous", "web", "index.html"), "utf8")).toContain("web v0.2.0");
	});
});
