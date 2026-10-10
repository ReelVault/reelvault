import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serverConfig } from "@/server.config";
import { installSessionStub, prepareSecuritySuite, send } from "./security-harness";

/**
 * Database backups are addressed by file name. Download, delete and restore must never
 * reach a file outside the backups directory: a sentinel `.sqlite` placed next to that
 * directory must survive every attempt, and no attempt may answer with its content.
 */

prepareSecuritySuite();

const sessionStub = installSessionStub();
afterAll(() => sessionStub.restore());

const name = `sentinel-backup-${crypto.randomUUID()}.sqlite`;
const sentinelPath = join(dirname(serverConfig.paths.backups), name);
const SENTINEL_CONTENT = "not-a-database-outside-the-backups-directory";

beforeAll(() => {
	mkdirSync(serverConfig.paths.backups, { recursive: true });
	writeFileSync(sentinelPath, SENTINEL_CONTENT);
});

afterAll(() => {
	if (existsSync(sentinelPath)) writeFileSync(sentinelPath, SENTINEL_CONTENT);
});

const HOSTILE_NAMES = [
	`../${name}`,
	`..%2F${name}`,
	`%2e%2e%2f${name}`,
	`..\\${name}`,
	`/${name}`,
	`%2F${name}`,
	`${name}%00.txt`,
	"..",
	"%2e%2e",
	`../../${name}`,
];

test("backup downloads never serve a file outside the backups directory", async () => {
	const findings: string[] = [];
	for (const fileName of HOSTILE_NAMES) {
		const response = await send("GET", `/v1/admin/database/backups/${fileName}/download`, { role: "admin" });
		const body = await response.text();
		if (response.status === 200 || body.includes(SENTINEL_CONTENT)) findings.push(`${fileName} -> ${response.status}`);
		if (response.status >= 500) findings.push(`${fileName} -> ${response.status}`);
	}
	expect(findings).toEqual([]);
});

test("backup deletions never remove a file outside the backups directory", async () => {
	const findings: string[] = [];
	for (const fileName of HOSTILE_NAMES) {
		const response = await send("DELETE", `/v1/admin/database/backups/${fileName}`, { role: "admin" });
		if (response.status >= 500) findings.push(`${fileName} -> ${response.status}`);
	}
	expect(findings).toEqual([]);
	expect(readFileSync(sentinelPath, "utf8")).toBe(SENTINEL_CONTENT);
});

test("a restore that names a file outside the backups directory is refused without touching the database", async () => {
	for (const fileName of [`../${name}`, `..\\${name}`, `/${name}`]) {
		const response = await send("POST", "/v1/admin/database/restore", { role: "admin", body: { fileName } });

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
	}
	expect(readFileSync(sentinelPath, "utf8")).toBe(SENTINEL_CONTENT);
});
