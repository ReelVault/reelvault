import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../tests/helpers/module-mock.helper";
import { updateCheckService } from "./update-check.service";
import { UpdateInstallService } from "./update-install.service";

// A dev checkout has no built web UI, so the installed web version is unknown. The test pins that
// host input instead of reading whatever the machine has built into the web distribution.
mockModuleWithRealExports("@/config/server/web-dist.utils", { resolveWebVersion: () => null });

function release(version: string): AdminUpdateRelease {
	return { version, name: `ReelVault ${version}`, url: "", publishedAt: null, notes: null, minServerVersion: null, assets: [] };
}

/** An install root that does not exist, so it holds no previous version and no web version marker. */
function emptyInstallRoot(): string {
	return join(tmpdir(), `rv-update-empty-${crypto.randomUUID()}`);
}

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

afterAll(() => {
	restoreModuleMocks();
});

describe("updateInstallService preflight", () => {
	test("refuses to install on a non-archive install type", async () => {
		for (const installType of ["docker", "dev"] as const) {
			const service = new UpdateInstallService({ installType, restartScheduler: { scheduleRestart: () => undefined } });
			await expect(service.startInstall("server")).rejects.toHaveProperty("code", "update.install_unsupported_install_type");
			await expect(service.startInstall("web")).rejects.toHaveProperty("code", "update.install_unsupported_install_type");
		}
	});

	test("refuses a web install without a known web version (dev checkout)", async () => {
		stubs.push(stubMethod(updateCheckService, "checkLatest", () => Promise.resolve()));
		stubs.push(stubMethod(updateCheckService, "getState", () => ({ serverLatest: null, webLatest: release("0.2.0") })));
		const service = new UpdateInstallService({
			installType: "archive",
			root: emptyInstallRoot(),
			restartScheduler: { scheduleRestart: () => undefined },
		});

		await expect(service.startInstall("web")).rejects.toHaveProperty("code", "update.up_to_date");
	});

	test("refuses rollback when no previous version exists", () => {
		const service = new UpdateInstallService({
			installType: "archive",
			root: emptyInstallRoot(),
			restartScheduler: { scheduleRestart: () => undefined },
		});

		expect(() => service.startRollback("server")).toThrow(
			expect.objectContaining({ category: "validation", code: "update.no_previous_version" }),
		);
		expect(service.isRollbackAvailable("server")).toBe(false);
		expect(service.isRollbackAvailable("web")).toBe(false);
	});

	test("a check that finds no release leaves no job behind", async () => {
		stubs.push(stubMethod(updateCheckService, "checkLatest", () => Promise.resolve()));
		stubs.push(stubMethod(updateCheckService, "getState", () => ({ serverLatest: null, webLatest: null })));
		const service = new UpdateInstallService({
			installType: "archive",
			root: emptyInstallRoot(),
			restartScheduler: { scheduleRestart: () => undefined },
		});

		await expect(service.startInstall("server")).rejects.toHaveProperty("code", "update.no_release_info");
		expect(service.getJob()).toBeNull();
	});
});
