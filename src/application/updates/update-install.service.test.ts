import { afterEach, describe, expect, test } from "bun:test";
import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { ValidationError } from "@/utils/errors";
import { updateCheckService } from "./update-check.service";
import { UpdateInstallService } from "./update-install.service";

function stubMethod(target: object, method: string, impl: (...args: never[]) => unknown): { restore(): void } {
	const original = Reflect.get(target, method) as unknown;
	Reflect.set(target, method, impl);

	return { restore: () => Reflect.set(target, method, original) };
}

function release(version: string): AdminUpdateRelease {
	return { version, name: `ReelVault ${version}`, url: "", publishedAt: null, notes: null, minServerVersion: null, assets: [] };
}

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("updateInstallService preflight", () => {
	test("refuses to install on a non-archive install type", async () => {
		for (const installType of ["docker", "dev"] as const) {
			const service = new UpdateInstallService({ installType, restartScheduler: { scheduleRestart: () => undefined } });
			await expect(service.startInstall("server")).rejects.toHaveProperty("code", "update.install_unsupported_install_type");
			await expect(service.startInstall("web")).rejects.toBeInstanceOf(ValidationError);
		}
	});

	test("refuses to install when the server is already up to date", async () => {
		stubs.push(stubMethod(updateCheckService, "checkLatest", () => Promise.resolve()));
		stubs.push(stubMethod(updateCheckService, "getState", () => ({ serverLatest: release("1.0.0"), webLatest: null })));
		const service = new UpdateInstallService({ installType: "archive", restartScheduler: { scheduleRestart: () => undefined } });

		await expect(service.startInstall("server")).rejects.toHaveProperty("code", "update.up_to_date");
		expect(service.getJob()).toBeNull();
	});

	test("refuses a web install without a known web version (dev checkout)", async () => {
		stubs.push(stubMethod(updateCheckService, "checkLatest", () => Promise.resolve()));
		stubs.push(stubMethod(updateCheckService, "getState", () => ({ serverLatest: null, webLatest: release("0.2.0") })));
		const service = new UpdateInstallService({ installType: "archive", restartScheduler: { scheduleRestart: () => undefined } });

		await expect(service.startInstall("web")).rejects.toHaveProperty("code", "update.up_to_date");
	});

	test("refuses rollback when no previous version exists", () => {
		const service = new UpdateInstallService({
			installType: "archive",
			root: "/tmp/rv-update-no-previous-nonexistent",
			restartScheduler: { scheduleRestart: () => undefined },
		});

		expect(() => service.startRollback("server")).toThrow();
		expect(service.isRollbackAvailable("server")).toBe(false);
		expect(service.isRollbackAvailable("web")).toBe(false);
	});

	test("a failed check leaves no job behind and records the per-component error", async () => {
		stubs.push(stubMethod(updateCheckService, "checkLatest", () => Promise.resolve()));
		stubs.push(stubMethod(updateCheckService, "getState", () => ({ serverLatest: null, webLatest: null })));
		const service = new UpdateInstallService({ installType: "archive", restartScheduler: { scheduleRestart: () => undefined } });

		await expect(service.startInstall("server")).rejects.toHaveProperty("code", "update.no_release_info");
		expect(service.getJob()).toBeNull();
	});
});
