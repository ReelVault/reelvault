import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { strToU8, zipSync } from "fflate";
import { databaseBackupService } from "@/application/admin/database-backup.service";
import { databaseMaintenanceService } from "@/application/admin/database-maintenance.service";
import type { ArchiveFetcher } from "@/plugins/catalog/plugin-package.utils";
import { detach } from "@/utils/promise.utils";
import { SERVER_VERSION } from "@/version";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { type UpdateCheckState, updateCheckService } from "./update-check.service";
import { updateHistoryService } from "./update-history.service";
import { type RestartScheduler, UpdateInstallService } from "./update-install.service";

const OLD_SERVER = "1.0.0";
// Derived from the running version so bumping the server package never makes
// the fixture release "not newer" than the server under test.
const [newMajor, newMinor, newPatch] = SERVER_VERSION.split(".").map(Number);
const NEW_SERVER = `${newMajor}.${newMinor}.${(newPatch ?? 0) + 1}`;
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
		webRequiresServerUpdate: false,
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

		stubPreUpdateCheck();
		const started = await service.startInstall("server");
		expect(started).toEqual({ started: true, target: "server", version: NEW_SERVER });

		await waitFor(() => scheduler.calls.length > 0);
		expect(service.getLastError("server")).toBeNull();
		expect(service.getJob()?.target).toBe("server");
		expect(service.getJob()?.state).toBe("restarting");
		expect(service.getJob()?.message).toContain("reelvault_backup_test.sqlite");
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

		expect(service.getLastError("server")).toBe("update.checksum_mismatch");
		expect(scheduler.calls).toEqual([]);
		expect(JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).toBe(OLD_SERVER);
		expect(existsSync(join(root, ".previous"))).toBe(false);
		expect(existsSync(join(root, ".update-staging"))).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});
});

/** The two database steps of a server install, stubbed so the tests write no real backup. */
function stubPreUpdateCheck(integrityOk = true): void {
	stubs.push(
		stubMethod(databaseBackupService, "createBackup", () =>
			Promise.resolve({
				fileName: "reelvault_backup_test.sqlite",
				filePath: join(tmpdir(), "reelvault_backup_test.sqlite"),
				sizeBytes: 2,
				createdAt: new Date().toISOString(),
			}),
		),
		stubMethod(databaseMaintenanceService, "checkIntegrity", () =>
			Promise.resolve(integrityOk ? { ok: true, messages: ["ok"] } : { ok: false, messages: ["row 3 missing from index"] }),
		),
	);
}

describe("server update database check", () => {
	test("a failed integrity check stops the update before any file is replaced", async () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const scheduler = fakeScheduler();
		const service = new UpdateInstallService({ root, installType: "archive", restartScheduler: scheduler, archiveFetcher: localFetcher });
		stubs.push(stubCheckState(serverRelease(), null));
		stubPreUpdateCheck(false);

		await service.startInstall("server");
		await waitFor(() => service.getJob() === null);

		expect(service.getLastError("server")).toBe("update.database_integrity_failed");
		expect(scheduler.calls).toEqual([]);
		expect(JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).toBe(OLD_SERVER);
		expect(existsSync(join(root, ".previous"))).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});
});

describe("server update disk check", () => {
	test("an install the disk cannot hold is refused before anything is downloaded", async () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const service = new UpdateInstallService({
			root,
			installType: "archive",
			restartScheduler: fakeScheduler(),
			archiveFetcher: localFetcher,
		});
		const release = serverRelease();
		stubs.push(
			stubCheckState({ ...release, assets: release.assets.map((asset) => ({ ...asset, size: Number.MAX_SAFE_INTEGER / 2 })) }, null),
		);

		await expect(service.startInstall("server")).rejects.toHaveProperty("code", "update.insufficient_disk_space");
		expect(service.getJob()).toBeNull();
		expect(JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).toBe(OLD_SERVER);

		rmSync(root, { recursive: true, force: true });
	});
});

describe("server update active streams guard", () => {
	test("a server install is refused while streams play, before anything is downloaded", async () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const scheduler = fakeScheduler();
		const service = new UpdateInstallService({
			root,
			installType: "archive",
			restartScheduler: scheduler,
			archiveFetcher: localFetcher,
			countActiveStreams: () => 2,
		});
		stubs.push(stubCheckState(serverRelease(), null));

		await expect(service.startInstall("server")).rejects.toMatchObject({
			code: "update.blocked_active_streams",
			params: { activeStreams: 2 },
		});
		expect(service.getJob()).toBeNull();
		expect(scheduler.calls).toEqual([]);
		expect(JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).toBe(OLD_SERVER);

		rmSync(root, { recursive: true, force: true });
	});

	test("force runs the server install while streams play", async () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const scheduler = fakeScheduler();
		const service = new UpdateInstallService({
			root,
			installType: "archive",
			restartScheduler: scheduler,
			archiveFetcher: localFetcher,
			countActiveStreams: () => 2,
		});
		stubs.push(stubCheckState(serverRelease(), null));
		stubPreUpdateCheck();

		await service.startInstall("server", null, { force: true });
		await waitFor(() => scheduler.calls.length > 0);
		expect(scheduler.calls).toEqual(["restart"]);
		expect(JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).toBe(NEW_SERVER);

		rmSync(root, { recursive: true, force: true });
	});

	test("a server rollback is refused while streams play, before the previous version is read", () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		mkdirSync(join(root, ".previous"), { recursive: true });
		writeFileSync(join(root, ".previous", "SERVER_VERSION"), OLD_SERVER);
		const scheduler = fakeScheduler();
		const service = new UpdateInstallService({
			root,
			installType: "archive",
			restartScheduler: scheduler,
			countActiveStreams: () => 1,
		});

		let thrown: unknown = null;
		try {
			service.startRollback("server");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({ code: "update.blocked_active_streams", params: { activeStreams: 1 } });
		expect(scheduler.calls).toEqual([]);
		expect(JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).toBe(OLD_SERVER);

		rmSync(root, { recursive: true, force: true });
	});

	test("a web install is never held back by streams", async () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const service = new UpdateInstallService({
			root,
			installType: "archive",
			restartScheduler: fakeScheduler(),
			archiveFetcher: localFetcher,
			countActiveStreams: () => 2,
		});
		stubs.push(stubCheckState(null, webRelease()));

		await expect(service.startInstall("web")).resolves.toEqual({ started: true, target: "web", version: NEW_WEB });
		await waitFor(() => service.getJob() === null);
		expect(service.getLastError("web")).toBeNull();
		expect(readFileSync(join(root, "web", "index.html"), "utf8")).toContain(`web v${NEW_WEB}`);

		rmSync(root, { recursive: true, force: true });
	});
});

describe("server update cancel", () => {
	test("cancelling a download stops it, keeps the running version and records a cancelled run, not a failure", async () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const scheduler = fakeScheduler();
		const hangingFetcher: ArchiveFetcher = (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		const service = new UpdateInstallService({
			root,
			installType: "archive",
			restartScheduler: scheduler,
			archiveFetcher: hangingFetcher,
		});
		stubs.push(stubCheckState(serverRelease(), null));
		const begin = stubMethod(updateHistoryService, "begin", () => Promise.resolve("run-1"));
		const cancel = stubMethod(updateHistoryService, "cancel", () => Promise.resolve());
		const fail = stubMethod(updateHistoryService, "fail", () => Promise.resolve());
		stubs.push(begin, cancel, fail);

		await service.startInstall("server");
		expect(service.cancelInstall("server")).toEqual({ target: "server" });
		await waitFor(() => cancel.calls.length === 1);

		expect(cancel.calls).toEqual([["run-1"]]);
		expect(fail.calls).toEqual([]);
		expect(service.getJob()).toBeNull();
		expect(service.getLastError("server")).toBeNull();
		expect(scheduler.calls).toEqual([]);
		expect(JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).toBe(OLD_SERVER);
		expect(existsSync(join(root, ".update-staging"))).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});

	test("a cancel is refused once the files are being replaced", () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const service = new UpdateInstallService({ root, installType: "archive", restartScheduler: fakeScheduler() });
		Reflect.set(service, "job", {
			target: "server",
			state: "swapping",
			progressPercent: 90,
			message: null,
			startedAt: new Date().toISOString(),
			targetVersion: NEW_SERVER,
		});

		let thrown: unknown = null;
		try {
			service.cancelInstall("server");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({ code: "update.not_cancellable", params: { state: "swapping" } });

		rmSync(root, { recursive: true, force: true });
	});

	test("a cancel with no install of that component running is refused", () => {
		const service = new UpdateInstallService({ installType: "archive", restartScheduler: fakeScheduler() });

		let thrown: unknown = null;
		try {
			service.cancelInstall("web");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({ code: "update.not_running" });
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

describe("update run history for the web UI", () => {
	test("opens and closes the install and the rollback with their outcomes", async () => {
		const root = makeRoot(OLD_SERVER, OLD_WEB);
		const service = new UpdateInstallService({
			root,
			installType: "archive",
			restartScheduler: fakeScheduler(),
			archiveFetcher: localFetcher,
		});
		stubs.push(stubCheckState(null, webRelease()));
		let opened = 0;
		const begin = stubMethod(updateHistoryService, "begin", () => {
			opened += 1;

			return Promise.resolve(`run-${opened}`);
		});
		const succeed = stubMethod(updateHistoryService, "succeed", () => Promise.resolve());
		const fail = stubMethod(updateHistoryService, "fail", () => Promise.resolve());
		stubs.push(begin, succeed, fail);

		await service.startInstall("web", "admin-1");
		await waitFor(() => succeed.calls.length === 1);
		expect(begin.calls[0]).toEqual([
			expect.objectContaining({ action: "install", target: "web", fromVersion: OLD_WEB, toVersion: NEW_WEB, actorUserId: "admin-1" }),
		]);
		expect(succeed.calls).toEqual([["run-1"]]);

		service.startRollback("web", "admin-1");
		await waitFor(() => succeed.calls.length === 2);
		expect(begin.calls[1]).toEqual([
			expect.objectContaining({ action: "rollback", target: "web", fromVersion: NEW_WEB, toVersion: OLD_WEB, actorUserId: "admin-1" }),
		]);
		expect(succeed.calls[1]).toEqual(["run-2"]);
		expect(fail.calls).toEqual([]);

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
