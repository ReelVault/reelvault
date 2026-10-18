import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { installSessionStub, prepareSecuritySuite, send } from "./security.helper";

/**
 * Admin log downloads and deletions take a `fileId` from the query string. The
 * resolver must confine every value to the logs directory: no traversal, no
 * absolute path, no encoded or whitespace trick may read or remove a file outside
 * it. A sentinel file placed next to the logs directory proves the boundary holds.
 */

prepareSecuritySuite();

const sessionStub = installSessionStub();
afterAll(() => sessionStub.restore());

const token = `sentinel-${crypto.randomUUID()}.txt`;
const sentinelPath = join(dirname(serverConfig.paths.logs), token);
const SENTINEL_CONTENT = "outside-the-logs-directory";

beforeAll(() => {
	mkdirSync(serverConfig.paths.logs, { recursive: true });
	writeFileSync(sentinelPath, SENTINEL_CONTENT);
});

afterAll(() => {
	rmSync(sentinelPath, { force: true });
});

/** A whitespace-only id names no file; it must be refused, never resolved to the active log. */
const WHITESPACE_ID = "%20";

const TRAVERSAL_VALUES = [
	`../${token}`,
	`..%2F${token}`,
	`%2e%2e%2f%2e%2e%2f${token}`,
	`../../${token}`,
	`..\\${token}`,
	`/${token}`,
	`/../${token}`,
	`//..//${token}`,
	`reelvault.log/../../${token}`,
	`reelvault.log%00../${token}`,
	`%2e%2e`,
	WHITESPACE_ID,
	`.`,
];

async function errorCode(response: Response): Promise<unknown> {
	const body = (await response.json()) as { code?: unknown };

	return body.code;
}

test("log downloads never serve a file outside the logs directory", async () => {
	const findings: string[] = [];

	for (const value of TRAVERSAL_VALUES) {
		const response = await send("GET", `/v1/admin/logs/download?fileId=${value}`, { role: "admin" });
		const body = await response.text();
		if (response.status === 200 && body.includes(SENTINEL_CONTENT)) findings.push(`${value} leaked the sentinel`);
		if (response.status >= 500) findings.push(`${value} -> ${response.status}`);
	}

	expect(findings).toEqual([]);
	expect(readFileSync(sentinelPath, "utf8")).toBe(SENTINEL_CONTENT);
});

test("log deletions never remove a file outside the logs directory", async () => {
	const findings: string[] = [];

	for (const value of TRAVERSAL_VALUES) {
		const response = await send("DELETE", `/v1/admin/logs?fileId=${value}`, { role: "admin" });
		if (response.status >= 500) findings.push(`${value} -> ${response.status}`);
		if (response.status === 200 && !existsSync(sentinelPath)) findings.push(`${value} removed the sentinel`);
	}

	expect(findings).toEqual([]);
	expect(readFileSync(sentinelPath, "utf8")).toBe(SENTINEL_CONTENT);
});

test("a dot-only log file id is refused as an invalid path with a stable code", async () => {
	const response = await send("DELETE", "/v1/admin/logs?fileId=.", { role: "admin" });

	expect(response.status).toBe(400);
	expect(await errorCode(response)).toBe("admin.log_path_invalid");
});

test("a whitespace-only log file id is refused and leaves the active log untouched", async () => {
	const activeLog = serverConfig.paths.logFile;
	const original = existsSync(activeLog) ? readFileSync(activeLog) : undefined;
	writeFileSync(activeLog, "line one\nline two\n");

	try {
		const response = await send("DELETE", `/v1/admin/logs?fileId=${WHITESPACE_ID}`, { role: "admin" });

		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe("admin.log_path_invalid");
		expect(readFileSync(activeLog, "utf8")).toBe("line one\nline two\n");
	} finally {
		if (original) writeFileSync(activeLog, original);
		else rmSync(activeLog, { force: true });
	}
});

test("deleting a log file that no longer exists answers 404, not a server error", async () => {
	const response = await send("DELETE", `/v1/admin/logs?fileId=${encodeURIComponent("reelvault-already-removed.log")}`, { role: "admin" });

	expect(response.status).toBe(404);
});

test("a missing main log file reads as an empty log for the list and the dashboard, not as a failure", async () => {
	const mainLog = serverConfig.paths.logFile;
	const original = existsSync(mainLog) ? readFileSync(mainLog) : undefined;
	rmSync(mainLog, { force: true });

	try {
		const list = await send("GET", "/v1/admin/logs", { role: "admin" });
		const dashboard = await send("GET", "/v1/admin/dashboard-view", { role: "admin" });

		expect(list.status).toBe(200);
		expect(((await list.json()) as { data: unknown[] }).data).toEqual([]);
		expect(dashboard.status).toBe(200);
	} finally {
		if (original) writeFileSync(mainLog, original);
	}
});
