import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeSync } from "@/utils/directory.utils";

/**
 * The maintenance commands run as separate processes on the machine that holds the data, so they are
 * exercised the same way: each runs against its own empty data directory.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const dataRoots: string[] = [];

afterAll(() => {
	for (const dir of dataRoots.splice(0)) removeTreeSync(dir);
});

async function runScript(args: string[]): Promise<{ exitCode: number; output: string }> {
	const dataRoot = mkdtempSync(join(tmpdir(), "rv-cli-"));
	dataRoots.push(dataRoot);
	const proc = Bun.spawn(["bun", "run", ...args], {
		cwd: REPO_ROOT,
		env: { ...process.env, ROOT_DIR: dataRoot, DB_FILE_NAME: "cli.sqlite" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

	return { exitCode: await proc.exited, output: `${stdout}${stderr}` };
}

describe("maintenance commands", () => {
	test("db:check passes on a sound database", async () => {
		const result = await runScript(["scripts/db-maintenance.script.ts", "check"]);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("integrity check passed");
	});

	test("db:backup writes a snapshot of the database to the target file", async () => {
		const target = join(mkdtempSync(join(tmpdir(), "rv-cli-target-")), "snapshot.sqlite");
		dataRoots.push(join(target, ".."));
		const result = await runScript(["scripts/db-maintenance.script.ts", "backup", target]);

		expect(result.exitCode).toBe(0);
		expect(existsSync(target)).toBe(true);
	});

	test("reset-password refuses an address that has no account and changes nothing", async () => {
		const result = await runScript(["scripts/reset-password.script.ts", "nobody@example.test"]);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("User not found: nobody@example.test");
	});

	test("reset-password without an email prints the usage and fails", async () => {
		const result = await runScript(["scripts/reset-password.script.ts"]);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("Usage: bun run admin:reset-password <email>");
	});

	test("doctor lists each check and exits non-zero only when a check fails", async () => {
		const result = await runScript(["scripts/doctor.script.ts"]);

		for (const check of ["bun", "ffmpeg", "ffprobe", "data directory", "disk space", "database", "web UI"]) {
			expect(result.output).toContain(check);
		}
		expect(result.exitCode).toBe(result.output.includes("✖") ? 1 : 0);
	});
});
