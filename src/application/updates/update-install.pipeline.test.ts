import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { strToU8, zipSync } from "fflate";
import type { ArchiveFetcher } from "@/plugins/catalog/plugin-package.utils";
import { detach } from "@/utils/promise.utils";
import { type UpdateCheckState, updateCheckService } from "./update-check.service";
import { type RestartScheduler, UpdateInstallService } from "./update-install.service";

const OLD_SERVER = "1.0.0";
const NEW_SERVER = "1.1.0";
const OLD_WEB = "0.1.0";
const NEW_WEB = "0.2.0";

const tempDirs: string[] = [];

function makeServerLayout(base: string, version: string): string {
	// Server archive layout: ReelVault/{bun, server, start.sh} — no web/, no bin/.
	const app = join(base, "ReelVault");
	mkdirSync(join(app, "server"), { recursive: true });
	mkdirSync(join(app, "bun"), { recursive: true });
	writeFileSync(join(app, "server", "package.json"), JSON.stringify({ version }));
	writeFileSync(join(app, "server", "index.ts"), `// server v${version}`);
	writeFileSync(join(app, "bun", "bun"), `bun-${version}`);
	writeFileSync(join(app, "start.sh"), `#!/bin/sh\n# launcher v${version}`);

	return app;
}

function packArchive(stagedApp: string, kind: "tar" | "zip"): { bytes: Uint8Array; checksum: string } {
	const stagingDir = join(stagedApp, "..");
	const archivePath = join(stagingDir, kind === "tar" ? "archive.tar.gz" : "archive.zip");
	if (kind === "tar") {
		Bun.spawnSync(["tar", "-czf", archivePath, "-C", stagingDir, "ReelVault"]);
	} else {
		Bun.spawnSync(["zip", "-qr", archivePath, "ReelVault"], { cwd: stagingDir });
	}
	const bytes = new Uint8Array(readFileSync(archivePath));
	rmSync(archivePath, { force: true });

	return { bytes, checksum: createHash("sha256").update(bytes).digest("hex") };
}

function packZip(files: Record<string, string>): { bytes: Uint8Array; checksum: string } {
	const entries: Record<string, Uint8Array> = {};
	for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
	const bytes = zipSync(entries, { level: 0 });

	return { bytes, checksum: createHash("sha256").update(bytes).digest("hex") };
}

const { bytes: webZipBytes, checksum: webZipChecksum } = packZip({
	"index.html": `<html>web v${NEW_WEB}</html>`,
	"version.json": JSON.stringify({ version: NEW_WEB }),
});
const webName = `reelvault-web-${NEW_WEB}.zip`;

const serverStaged = mkdtempSync(join(tmpdir(), "rv-pipeline-server-"));
tempDirs.push(serverStaged);
makeServerLayout(serverStaged, NEW_SERVER);
const { bytes: serverTarBytes, checksum: serverTarChecksum } = packArchive(join(serverStaged, "ReelVault"), "tar");

const serverName = `ReelVault-Server-${NEW_SERVER}-linux-x64.tar.gz`;
let serveWrongSums = false;

const archiveServer = Bun.serve({
	port: 0,
	fetch: (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/server/SHA256SUMS.txt") {
			const digest = serveWrongSums ? "0".repeat(64) : serverTarChecksum;

			return new Response(`${digest}  ${serverName}\n`, { headers: { "content-type": "text/plain" } });
		}
		if (url.pathname === `/server/${serverName}`) {
			return new Response(new Blob([serverTarBytes as BlobPart]), { headers: { "content-type": "application/gzip" } });
		}
		if (url.pathname === "/web/SHA256SUMS.txt") {
			const digest = serveWrongSums ? "0".repeat(64) : webZipChecksum;

			return new Response(`${digest}  ${webName}\n`, { headers: { "content-type": "text/plain" } });
		}
		if (url.pathname === `/web/${webName}`) {
			return new Response(new Blob([webZipBytes as BlobPart]), { headers: { "content-type": "application/zip" } });
		}

		return new Response("not found", { status: 404 });
	},
});
const serverArchiveUrl = `http://127.0.0.1:${archiveServer.port}/server/${serverName}`;
const serverSumsUrl = `http://127.0.0.1:${archiveServer.port}/server/SHA256SUMS.txt`;

const localFetcher: ArchiveFetcher = (url, init) => fetch(url, init);

function makeRoot(serverVersion: string, webVersion: string): string {
	const root = mkdtempSync(join(tmpdir(), "rv-pipeline-root-"));
	tempDirs.push(root);
	const src = mkdtempSync(join(tmpdir(), "rv-pipeline-src-"));
	tempDirs.push(src);
	makeServerLayout(src, serverVersion);
	// The installed web/ root carries version.json — the updater compares against it.
	const webDir = mkdtempSync(join(tmpdir(), "rv-pipeline-webinstall-"));
	tempDirs.push(webDir);
	writeFileSync(join(webDir, "index.html"), `<html>web v${webVersion}</html>`);
	writeFileSync(join(webDir, "version.json"), JSON.stringify({ version: webVersion }));
	Bun.spawnSync(["cp", "-a", `${join(src, "ReelVault")}/.`, root]);
	Bun.spawnSync(["cp", "-a", `${webDir}/.`, join(root, "web")]);
	writeFileSync(join(root, "settings.env"), "export APP_PORT=3030\n");
	mkdirSync(join(root, "data"), { recursive: true });
	writeFileSync(join(root, "data", "reelvault.db"), "db");

	return root;
}

function stubCheckState(serverLatest: AdminUpdateRelease | null, webLatest: AdminUpdateRelease | null): { restore(): void } {
	const state: UpdateCheckState = {
		serverLatest,
		webLatest,
		serverUpdateAvailable: Boolean(serverLatest),
		webUpdateAvailable: Boolean(webLatest),
		lastCheckedAt: new Date().toISOString(),
		serverLastError: null,
		webLastError: null,
	};
	const original = Reflect.get(updateCheckService, "checkLatest") as unknown;
	Reflect.set(updateCheckService, "checkLatest", () => Promise.resolve());
	const originalGetState = Reflect.get(updateCheckService, "getState") as unknown;
	Reflect.set(updateCheckService, "getState", () => state);

	return {
		restore: () => {
			Reflect.set(updateCheckService, "checkLatest", original);
			Reflect.set(updateCheckService, "getState", originalGetState);
		},
	};
}

function serverRelease(): AdminUpdateRelease {
	return {
		version: NEW_SERVER,
		name: `ReelVault Server ${NEW_SERVER}`,
		url: "",
		publishedAt: null,
		notes: null,
		minServerVersion: null,
		assets: [
			{ name: serverName, url: serverArchiveUrl, size: serverTarBytes.byteLength },
			{ name: "SHA256SUMS.txt", url: serverSumsUrl, size: 128 },
		],
	};
}

function fakeScheduler(): RestartScheduler & { calls: string[] } {
	const calls: string[] = [];

	return { calls, scheduleRestart: () => calls.push("restart") };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(25);
}

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	serveWrongSums = false;
	for (const stub of stubs.splice(0)) stub.restore();
});
afterAll(() => {
	detach(archiveServer.stop(true));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server update pipeline (local HTTP archive)", () => {
	test("downloads, verifies, extracts and swaps the server, leaves web untouched", async () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const scheduler = fakeScheduler();
		const service = new UpdateInstallService({ root, installType: "archive", restartScheduler: scheduler, archiveFetcher: localFetcher });
		stubs.push(stubCheckState(serverRelease(), null));

		const started = await service.startInstall("server");
		expect(started).toEqual({ started: true, target: "server", version: NEW_SERVER });

		await waitFor(() => scheduler.calls.length > 0);
		expect(service.getLastError("server")).toBeNull();
		expect(service.getJob()?.target).toBe("server");
		expect(service.getJob()?.state).toBe("restarting");
		expect(scheduler.calls).toEqual(["restart"]);

		// New server is live, web was NOT touched
		expect(JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).toBe(NEW_SERVER);
		expect(readFileSync(join(root, "web", "index.html"), "utf8")).toContain(`v${OLD_WEB}`);
		expect(readPreviousVersionOf(root, "server")).toBe(OLD_SERVER);
		expect(readFileSync(join(root, "settings.env"), "utf8")).toContain("APP_PORT");
		expect(readFileSync(join(root, "data", "reelvault.db"), "utf8")).toBe("db");
		expect(service.isRollbackAvailable("server")).toBe(true);
		expect(service.isRollbackAvailable("web")).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});

	test("a checksum mismatch aborts the install and leaves the running version untouched", async () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const scheduler = fakeScheduler();
		const service = new UpdateInstallService({ root, installType: "archive", restartScheduler: scheduler, archiveFetcher: localFetcher });
		stubs.push(stubCheckState(serverRelease(), null));

		serveWrongSums = true;
		await service.startInstall("server");
		await waitFor(() => service.getJob() === null);

		expect(service.getLastError("server")).toContain("SHA256");
		expect(scheduler.calls).toEqual([]);
		expect(JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).toBe(OLD_SERVER);
		expect(existsSync(join(root, ".previous"))).toBe(false);
		expect(existsSync(join(root, ".update-staging"))).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});
});

describe("web update pipeline (local HTTP zip, no restart)", () => {
	test("swaps web/ in place, keeps the server running, no restart scheduled", async () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const scheduler = fakeScheduler();
		const service = new UpdateInstallService({ root, installType: "archive", restartScheduler: scheduler, archiveFetcher: localFetcher });
		stubs.push(stubCheckState(null, webRelease()));

		const started = await service.startInstall("web");
		expect(started).toEqual({ started: true, target: "web", version: NEW_WEB });

		// Web install finishes without a restart — the job disappears after the swap.
		await waitFor(() => service.getJob() === null);
		expect(service.getLastError("web")).toBeNull();
		expect(scheduler.calls).toEqual([]);

		expect(readFileSync(join(root, "web", "index.html"), "utf8")).toContain(`web v${NEW_WEB}`);
		expect(JSON.parse(readFileSync(join(root, "web", "version.json"), "utf8")).version).toBe(NEW_WEB);
		// Server was NOT touched
		expect(JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).toBe(OLD_SERVER);
		expect(readPreviousVersionOf(root, "web")).toBe(OLD_WEB);
		expect(service.isRollbackAvailable("web")).toBe(true);
		expect(service.isRollbackAvailable("server")).toBe(false);

		// Web rollback is also restart-free
		const rolledBack = service.startRollback("web");
		expect(rolledBack.version).toBe(OLD_WEB);
		expect(service.getJob()).toBeNull();
		expect(scheduler.calls).toEqual([]);
		expect(readFileSync(join(root, "web", "index.html"), "utf8")).toContain(`v${OLD_WEB}`);

		rmSync(root, { recursive: true, force: true });
	});
});

const webArchiveUrl = `http://127.0.0.1:${archiveServer.port}/web/${webName}`;
const webSumsUrl = `http://127.0.0.1:${archiveServer.port}/web/SHA256SUMS.txt`;

function webRelease(): AdminUpdateRelease {
	return {
		version: NEW_WEB,
		name: `ReelVault Web ${NEW_WEB}`,
		url: "",
		publishedAt: null,
		notes: null,
		minServerVersion: null,
		assets: [
			{ name: webName, url: webArchiveUrl, size: webZipBytes.byteLength },
			{ name: "SHA256SUMS.txt", url: webSumsUrl, size: 128 },
		],
	};
}

function readPreviousVersionOf(root: string, component: "server" | "web"): string {
	const marker = component === "server" ? "SERVER_VERSION" : "WEB_VERSION";

	return readFileSync(join(root, ".previous", marker), "utf8").trim();
}
